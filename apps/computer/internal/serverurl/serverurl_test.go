package serverurl_test

import (
	"errors"
	"strings"
	"testing"

	"agentum.dev/computer/internal/serverurl"
)

// Both the enrollment code and the machine credential cross this URL. Plaintext to anything
// but this machine puts them on the wire in the clear.
func TestPlaintextIsRefusedExceptToThisMachine(t *testing.T) {
	for _, allowed := range []string{
		"http://localhost:8787",
		"http://127.0.0.1:8787",
		"http://[::1]:8787",
		"http://127.0.0.5",
		"ws://localhost:8787",
	} {
		if _, err := serverurl.Parse(allowed); err != nil {
			t.Fatalf("%q was refused: %v", allowed, err)
		}
	}
	for _, refused := range []string{
		"http://agentum.example.com",
		"http://192.168.1.10:8787",
		"http://10.0.0.1",
		"ws://agentum.example.com",
		"http://localhost.evil.com",
		// A subdomain is whatever the resolver says it is, and the static build's resolver
		// may ask DNS for it.
		"http://app.localhost:8787",
	} {
		_, err := serverurl.Parse(refused)
		if !errors.Is(err, serverurl.ErrInsecure) {
			t.Fatalf("%q was accepted: %v", refused, err)
		}
		if !strings.Contains(err.Error(), "https://") {
			t.Fatalf("the refusal for %q does not say what to do instead: %v", refused, err)
		}
	}
}

func TestSchemeMapping(t *testing.T) {
	websockets := map[string]string{
		"https://example.com":        "wss://example.com/api/v1/computers/connect",
		"https://example.com/":       "wss://example.com/api/v1/computers/connect",
		"wss://example.com":          "wss://example.com/api/v1/computers/connect",
		"http://127.0.0.1:8787":      "ws://127.0.0.1:8787/api/v1/computers/connect",
		"https://example.com/prefix": "wss://example.com/prefix/api/v1/computers/connect",
	}
	for input, want := range websockets {
		got, err := serverurl.WebSocket(input, "/api/v1/computers/connect")
		if err != nil {
			t.Fatalf("WebSocket(%q): %v", input, err)
		}
		if got != want {
			t.Fatalf("WebSocket(%q) = %q, want %q", input, got, want)
		}
	}

	https := map[string]string{
		"https://example.com":   "https://example.com/api/v1/computers/enroll",
		"wss://example.com":     "https://example.com/api/v1/computers/enroll",
		"http://127.0.0.1:8787": "http://127.0.0.1:8787/api/v1/computers/enroll",
	}
	for input, want := range https {
		got, err := serverurl.HTTP(input, "/api/v1/computers/enroll")
		if err != nil {
			t.Fatalf("HTTP(%q): %v", input, err)
		}
		if got != want {
			t.Fatalf("HTTP(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestMalformedURLsAreRefused(t *testing.T) {
	for _, bad := range []string{"", "   ", "example.com", "ftp://example.com", "https://"} {
		if _, err := serverurl.Parse(bad); err == nil {
			t.Fatalf("%q was accepted", bad)
		}
	}
}

// A query string or fragment on the base URL would otherwise end up on every request.
func TestCanonicalStripsTheExtras(t *testing.T) {
	got, err := serverurl.Canonical("https://example.com/base/?token=leak#frag")
	if err != nil {
		t.Fatalf("Canonical: %v", err)
	}
	if got != "https://example.com/base" {
		t.Fatalf("Canonical = %q", got)
	}
}

func TestIsLoopback(t *testing.T) {
	for _, yes := range []string{"localhost", "LOCALHOST", "127.0.0.1", "127.1.2.3", "::1", "[::1]"} {
		if !serverurl.IsLoopback(yes) {
			t.Fatalf("%q was not recognised as this machine", yes)
		}
	}
	for _, no := range []string{"example.com", "192.168.0.1", "0.0.0.0", "localhost.evil.com", "api.localhost", ""} {
		if serverurl.IsLoopback(no) {
			t.Fatalf("%q was treated as this machine", no)
		}
	}
}
