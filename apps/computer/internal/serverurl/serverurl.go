// Package serverurl is the one place that decides whether a server URL is usable. Both the
// enrollment call and the WebSocket dial carry secrets, so both ask here.
package serverurl

import (
	"errors"
	"fmt"
	"net"
	"net/url"
	"strings"
)

// ErrInsecure is returned for a plaintext URL to anything but this machine.
var ErrInsecure = errors.New("refusing to send credentials over plaintext")

// Parse validates a base URL and returns it with any trailing slash removed.
func Parse(raw string) (*url.URL, error) {
	trimmed := strings.TrimSuffix(strings.TrimSpace(raw), "/")
	if trimmed == "" {
		return nil, errors.New("a server URL is required")
	}
	parsed, err := url.Parse(trimmed)
	if err != nil {
		return nil, fmt.Errorf("parse the server URL %q: %w", raw, err)
	}
	switch parsed.Scheme {
	case "https", "wss", "http", "ws":
	default:
		return nil, fmt.Errorf("the server URL %q must be http(s) or ws(s)", raw)
	}
	if parsed.Host == "" {
		return nil, fmt.Errorf("the server URL %q has no host", raw)
	}
	if isPlaintext(parsed.Scheme) && !IsLoopback(parsed.Hostname()) {
		return nil, fmt.Errorf(
			"%w: %q is plaintext and %s is not this machine. The enrollment code, the machine credential and every command cross the network in the clear. Use https:// (plaintext is accepted only for localhost, 127.0.0.0/8 and ::1, for development)",
			ErrInsecure, raw, parsed.Hostname())
	}
	return parsed, nil
}

// HTTP returns the base URL with path appended, for the enrollment call.
func HTTP(raw string, path string) (string, error) {
	parsed, err := Parse(raw)
	if err != nil {
		return "", err
	}
	switch parsed.Scheme {
	case "wss":
		parsed.Scheme = "https"
	case "ws":
		parsed.Scheme = "http"
	}
	return join(parsed, path), nil
}

// WebSocket returns the base URL with path appended and the scheme upgraded to ws or wss.
func WebSocket(raw string, path string) (string, error) {
	parsed, err := Parse(raw)
	if err != nil {
		return "", err
	}
	switch parsed.Scheme {
	case "https":
		parsed.Scheme = "wss"
	case "http":
		parsed.Scheme = "ws"
	}
	return join(parsed, path), nil
}

// Canonical returns the base URL as it should be stored in the config.
func Canonical(raw string) (string, error) {
	parsed, err := Parse(raw)
	if err != nil {
		return "", err
	}
	parsed.RawQuery = ""
	parsed.Fragment = ""
	parsed.Path = strings.TrimSuffix(parsed.Path, "/")
	return parsed.String(), nil
}

func join(parsed *url.URL, path string) string {
	parsed.Path = strings.TrimSuffix(parsed.Path, "/") + path
	parsed.RawQuery = ""
	parsed.Fragment = ""
	return parsed.String()
}

func isPlaintext(scheme string) bool {
	return scheme == "http" || scheme == "ws"
}

// IsLoopback reports whether a host names this machine, which is the only case where
// plaintext costs nothing because the traffic never reaches a network. Only a literal
// loopback address and the exact name "localhost" count: a subdomain like app.localhost is
// resolved by whatever the system's resolver says, and the static build's resolver may well
// ask DNS for it.
func IsLoopback(hostname string) bool {
	lowered := strings.ToLower(strings.Trim(hostname, "[]"))
	if lowered == "localhost" {
		return true
	}
	if address := net.ParseIP(lowered); address != nil {
		return address.IsLoopback()
	}
	return false
}
