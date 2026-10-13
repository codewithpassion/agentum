// Package enroll exchanges a single-use enrollment code for the machine credential this
// computer keeps.
package enroll

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"agentum.dev/computer/internal/serverurl"
)

// Path is the unauthenticated enrollment endpoint.
const Path = "/api/v1/computers/enroll"

// ErrCodeRejected means the code was wrong, has expired, or has already been used. The server
// cannot say which, and neither can we.
var ErrCodeRejected = errors.New("the enrollment code was refused: it is wrong, expired, or already used")

// Request is the wire body, exactly as the server reads it.
type Request struct {
	EnrollmentCode string `json:"enrollment_code"`
	Hostname       string `json:"hostname"`
	OS             string `json:"os"`
	Arch           string `json:"arch"`
	Version        string `json:"version"`
}

// Result is what a successful enrollment returns.
type Result struct {
	ComputerID        string `json:"computer_id"`
	MachineCredential string `json:"machine_credential"`
}

type response struct {
	Data Result `json:"data"`
}

// maxBody bounds what is read back, so a misrouted URL answering with a large page cannot be
// swallowed whole.
const maxBody = 1 << 20

// Do exchanges the code. The only client-visible failures are a rejected code and everything
// else, because the operator's next step differs sharply between the two.
func Do(ctx context.Context, client *http.Client, baseURL string, request Request) (Result, error) {
	endpoint, err := URL(baseURL)
	if err != nil {
		return Result{}, err
	}
	if strings.TrimSpace(request.EnrollmentCode) == "" {
		return Result{}, errors.New("an enrollment code is required")
	}
	body, err := json.Marshal(request)
	if err != nil {
		return Result{}, fmt.Errorf("encode the enrollment request: %w", err)
	}
	httpRequest, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return Result{}, fmt.Errorf("build the enrollment request: %w", err)
	}
	httpRequest.Header.Set("Content-Type", "application/json")
	httpRequest.Header.Set("Accept", "application/json")

	if client == nil {
		client = DefaultClient()
	}
	httpResponse, err := client.Do(httpRequest)
	if err != nil {
		return Result{}, fmt.Errorf("reach %s: %w", endpoint, err)
	}
	defer func() { _ = httpResponse.Body.Close() }()

	raw, err := io.ReadAll(io.LimitReader(httpResponse.Body, maxBody))
	if err != nil {
		return Result{}, fmt.Errorf("read the enrollment response: %w", err)
	}
	if httpResponse.StatusCode == http.StatusUnauthorized {
		return Result{}, ErrCodeRejected
	}
	if httpResponse.StatusCode != http.StatusOK {
		return Result{}, fmt.Errorf("enrollment failed: %s answered %s: %s",
			endpoint, httpResponse.Status, summarise(raw))
	}

	var decoded response
	if err := json.Unmarshal(raw, &decoded); err != nil {
		return Result{}, fmt.Errorf("parse the enrollment response from %s: %w", endpoint, err)
	}
	if decoded.Data.ComputerID == "" || decoded.Data.MachineCredential == "" {
		return Result{}, fmt.Errorf("the enrollment response from %s carried no credential", endpoint)
	}
	return decoded.Data, nil
}

// URL builds the enrollment endpoint from the base URL the operator gave, refusing plaintext
// to anything but this machine.
func URL(baseURL string) (string, error) {
	return serverurl.HTTP(baseURL, Path)
}

// DefaultClient refuses redirects. A 307 or 308 re-sends the body, so a redirect would hand
// the single-use enrollment code to whatever the first server named — including, on an
// https-to-http hop, the network.
func DefaultClient() *http.Client {
	return &http.Client{
		Timeout: 30 * time.Second,
		CheckRedirect: func(request *http.Request, via []*http.Request) error {
			return fmt.Errorf("%w: %s redirected to %s", ErrRedirected, via[0].URL.Redacted(), request.URL.Redacted())
		},
	}
}

// ErrRedirected is its own error because the operator's fix is to use the final URL.
var ErrRedirected = errors.New("the enrollment endpoint redirected, which would resend the code elsewhere")

// summarise keeps an unexpected error body short enough to log without flooding it.
func summarise(raw []byte) string {
	text := strings.TrimSpace(string(raw))
	if text == "" {
		return "(no body)"
	}
	if len(text) > 300 {
		return text[:300] + "…"
	}
	return text
}
