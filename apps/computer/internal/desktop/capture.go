package desktop

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"image"
	"image/jpeg"
	"io"
	"log"
	"math/bits"
	"net"
	"time"

	"github.com/jezek/xgb"
	"github.com/jezek/xgb/xproto"

	"agentum.dev/computer/internal/protocol"
)

// screenshotBudget bounds one capture end to end, inside the server's 5 s timeout.
const screenshotBudget = 4 * time.Second

func init() {
	// xgb logs connection trouble to stderr on its own; this package reports it instead.
	xgb.Logger = log.New(io.Discard, "", 0)
}

// connect opens a fresh connection with the cookie. One per capture costs about a millisecond
// on the unix socket and never outlives an Xvfb restart. A display this desktop's Xvfb does not
// hold is never dialled.
func (d *Desktop) connect(budget time.Duration) (*xgb.Conn, error) {
	if err := d.ownsDisplay(); err != nil {
		return nil, fmt.Errorf("%w: %w", ErrUnavailable, err)
	}
	socket, err := net.DialTimeout("unix", d.socket, budget)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", ErrUnavailable, err)
	}
	// The deadline bounds every read xgb makes, so a wedged server cannot hold a handler.
	if err := socket.SetDeadline(time.Now().Add(budget)); err != nil {
		_ = socket.Close()
		return nil, fmt.Errorf("%w: %w", ErrUnavailable, err)
	}
	conn, err := xgb.NewConnNetWithCookieHex(socket, d.cookieHex)
	if err != nil {
		_ = socket.Close()
		return nil, fmt.Errorf("%w: %w", ErrUnavailable, err)
	}
	return conn, nil
}

// ScreenshotQuality settles the requested JPEG quality: null means the default.
func ScreenshotQuality(requested *int) (int, error) {
	if requested == nil {
		return protocol.DesktopDefaultQuality, nil
	}
	if *requested < 1 || *requested > protocol.DesktopMaxQuality {
		return 0, fmt.Errorf("%w: quality must be between 1 and %d", ErrBadRequest, protocol.DesktopMaxQuality)
	}
	return *requested, nil
}

// Screenshot captures the whole root window in-process and encodes it as JPEG.
func (d *Desktop) Screenshot(quality int) (protocol.DesktopScreenshotResult, error) {
	ctx, cancel := context.WithTimeout(context.Background(), screenshotBudget)
	defer cancel()
	release, err := acquire(ctx, d.shots)
	if err != nil {
		return protocol.DesktopScreenshotResult{}, err
	}
	defer release()
	deadline, _ := ctx.Deadline()
	conn, err := d.connect(time.Until(deadline))
	if err != nil {
		return protocol.DesktopScreenshotResult{}, err
	}
	defer conn.Close()

	setup := xproto.Setup(conn)
	screen := setup.DefaultScreen(conn)
	reply, err := xproto.GetImage(conn, xproto.ImageFormatZPixmap, xproto.Drawable(screen.Root),
		0, 0, screen.WidthInPixels, screen.HeightInPixels, 0xffffffff).Reply()
	if err != nil {
		return protocol.DesktopScreenshotResult{}, fmt.Errorf("capture the screen: %w", err)
	}
	layout, err := pixelLayoutOf(setup, screen, reply.Depth)
	if err != nil {
		return protocol.DesktopScreenshotResult{}, err
	}
	frame, err := layout.decode(reply.Data, int(screen.WidthInPixels), int(screen.HeightInPixels))
	if err != nil {
		return protocol.DesktopScreenshotResult{}, err
	}
	return encodeScreenshot(frame, quality)
}

// encodeScreenshot turns a frame into the op's result, refusing one over the size cap rather
// than sending a frame the relay would drop.
func encodeScreenshot(frame image.Image, quality int) (protocol.DesktopScreenshotResult, error) {
	var encoded bytes.Buffer
	if err := jpeg.Encode(&encoded, frame, &jpeg.Options{Quality: quality}); err != nil {
		return protocol.DesktopScreenshotResult{}, fmt.Errorf("encode the screenshot: %w", err)
	}
	data := base64.StdEncoding.EncodeToString(encoded.Bytes())
	if len(data) > protocol.DesktopMaxResultBytes {
		return protocol.DesktopScreenshotResult{}, fmt.Errorf("%w: the screenshot is %d bytes encoded, over the %d limit; ask for a lower quality",
			ErrTooLarge, len(data), protocol.DesktopMaxResultBytes)
	}
	bounds := frame.Bounds()
	return protocol.DesktopScreenshotResult{
		DataB64:   data,
		Width:     bounds.Dx(),
		Height:    bounds.Dy(),
		MediaType: protocol.DesktopMediaType,
	}, nil
}

// pixelLayout is how a ZPixmap scanline packs one pixel on this server.
type pixelLayout struct {
	bytesPerPixel int
	order         binary.ByteOrder
	red           uint32
	green         uint32
	blue          uint32
}

func pixelLayoutOf(setup *xproto.SetupInfo, screen *xproto.ScreenInfo, depth byte) (pixelLayout, error) {
	bitsPerPixel := 0
	for _, format := range setup.PixmapFormats {
		if format.Depth == depth {
			bitsPerPixel = int(format.BitsPerPixel)
		}
	}
	if bitsPerPixel != 32 {
		return pixelLayout{}, fmt.Errorf("the display packs depth %d at %d bits per pixel; only 32 is supported", depth, bitsPerPixel)
	}
	var visual *xproto.VisualInfo
	for _, allowed := range screen.AllowedDepths {
		for index := range allowed.Visuals {
			if allowed.Visuals[index].VisualId == screen.RootVisual {
				visual = &allowed.Visuals[index]
			}
		}
	}
	if visual == nil {
		return pixelLayout{}, fmt.Errorf("the root visual is not described by the server")
	}
	var order binary.ByteOrder = binary.LittleEndian
	if setup.ImageByteOrder == xproto.ImageOrderMSBFirst {
		order = binary.BigEndian
	}
	return pixelLayout{bytesPerPixel: 4, order: order, red: visual.RedMask, green: visual.GreenMask, blue: visual.BlueMask}, nil
}

func (l pixelLayout) decode(data []byte, width int, height int) (*image.RGBA, error) {
	stride := width * l.bytesPerPixel
	if len(data) < stride*height {
		return nil, fmt.Errorf("the server returned %d bytes for a %dx%d image", len(data), width, height)
	}
	frame := image.NewRGBA(image.Rect(0, 0, width, height))
	for y := 0; y < height; y++ {
		row := data[y*stride : (y+1)*stride]
		out := frame.Pix[y*frame.Stride:]
		for x := 0; x < width; x++ {
			pixel := l.order.Uint32(row[x*4:])
			out[x*4] = channel(pixel, l.red)
			out[x*4+1] = channel(pixel, l.green)
			out[x*4+2] = channel(pixel, l.blue)
			out[x*4+3] = 0xff
		}
	}
	return frame, nil
}

// channel extracts one 8-bit colour channel by its mask.
func channel(pixel uint32, mask uint32) byte {
	if mask == 0 {
		return 0
	}
	return byte((pixel & mask) >> bits.TrailingZeros32(mask))
}
