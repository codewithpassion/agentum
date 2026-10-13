package enroll_test

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"agentum.dev/computer/internal/enroll"
)

func fixture(t *testing.T, name string) []byte {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "testdata", "enroll", name))
	if err != nil {
		t.Fatalf("read fixture %s: %v", name, err)
	}
	return raw
}

func TestURLDerivation(t *testing.T) {
	for input, want := range map[string]string{
		"https://agentum.example.com":  "https://agentum.example.com/api/v1/computers/enroll",
		"https://agentum.example.com/": "https://agentum.example.com/api/v1/computers/enroll",
		// Plaintext to this machine is the development case and stays allowed.
		"http://127.0.0.1:8787": "http://127.0.0.1:8787/api/v1/computers/enroll",
		// A websocket scheme names the same server; the enrollment call is still HTTP.
		"wss://agentum.example.com": "https://agentum.example.com/api/v1/computers/enroll",
	} {
		got, err := enroll.URL(input)
		if err != nil {
			t.Fatalf("URL(%q): %v", input, err)
		}
		if got != want {
			t.Fatalf("URL(%q) = %q, want %q", input, got, want)
		}
	}
	for _, bad := range []string{"", "agentum.example.com", "http://agentum.example.com"} {
		if _, err := enroll.URL(bad); err == nil {
			t.Fatalf("URL(%q) was accepted", bad)
		}
	}
}

// A 307 or 308 re-sends the body, so following a redirect would hand the single-use code to
// wherever the first server pointed — including, on an https-to-http hop, the network.
func TestRedirectsAreRefused(t *testing.T) {
	final := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		_, _ = writer.Write([]byte(`{"data":{"computer_id":"c","machine_credential":"m"}}`))
	}))
	defer final.Close()
	redirector := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		http.Redirect(writer, request, final.URL+enroll.Path, http.StatusTemporaryRedirect)
	}))
	defer redirector.Close()

	_, err := enroll.Do(context.Background(), enroll.DefaultClient(), redirector.URL, enroll.Request{EnrollmentCode: "code"})
	if !errors.Is(err, enroll.ErrRedirected) {
		t.Fatalf("error = %v, want ErrRedirected", err)
	}
}

// The request the client sends and the response it accepts are the committed fixtures, which
// is the same pair the server's schemas are checked against.
func TestSuccessfulEnrollmentMatchesTheFixtures(t *testing.T) {
	var received []byte
	var receivedPath string
	var contentType string
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		receivedPath = request.URL.Path
		contentType = request.Header.Get("Content-Type")
		body, err := io.ReadAll(request.Body)
		if err != nil {
			writer.WriteHeader(http.StatusInternalServerError)
			return
		}
		received = body
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write(fixture(t, "response.json"))
	}))
	defer server.Close()

	var want enroll.Request
	if err := json.Unmarshal(fixture(t, "request.json"), &want); err != nil {
		t.Fatalf("decode the request fixture: %v", err)
	}

	result, err := enroll.Do(context.Background(), server.Client(), server.URL, want)
	if err != nil {
		t.Fatalf("enroll: %v", err)
	}
	if receivedPath != enroll.Path {
		t.Fatalf("posted to %q, want %q", receivedPath, enroll.Path)
	}
	if contentType != "application/json" {
		t.Fatalf("content type = %q", contentType)
	}

	var sent enroll.Request
	if err := json.Unmarshal(received, &sent); err != nil {
		t.Fatalf("decode what was sent: %v", err)
	}
	if !reflect.DeepEqual(sent, want) {
		t.Fatalf("sent %+v, want %+v", sent, want)
	}

	var expected struct {
		Data enroll.Result `json:"data"`
	}
	if err := json.Unmarshal(fixture(t, "response.json"), &expected); err != nil {
		t.Fatalf("decode the response fixture: %v", err)
	}
	if result != expected.Data {
		t.Fatalf("result = %+v, want %+v", result, expected.Data)
	}
}

// A 401 is the one failure the operator can act on, so it gets its own error.
func TestRejectedCodeIsItsOwnError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.WriteHeader(http.StatusUnauthorized)
		_, _ = writer.Write([]byte(`{"error":{"message":"unauthorized"}}`))
	}))
	defer server.Close()

	_, err := enroll.Do(context.Background(), server.Client(), server.URL, enroll.Request{EnrollmentCode: "nope"})
	if !errors.Is(err, enroll.ErrCodeRejected) {
		t.Fatalf("error = %v, want ErrCodeRejected", err)
	}
}

func TestOtherFailuresCarryTheStatus(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.WriteHeader(http.StatusBadGateway)
		_, _ = writer.Write([]byte("upstream is down"))
	}))
	defer server.Close()

	_, err := enroll.Do(context.Background(), server.Client(), server.URL, enroll.Request{EnrollmentCode: "x"})
	if err == nil || errors.Is(err, enroll.ErrCodeRejected) {
		t.Fatalf("error = %v", err)
	}
}

func TestAResponseWithoutACredentialIsRefused(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		_, _ = writer.Write([]byte(`{"data":{"computer_id":"cmp_1"}}`))
	}))
	defer server.Close()

	if _, err := enroll.Do(context.Background(), server.Client(), server.URL, enroll.Request{EnrollmentCode: "x"}); err == nil {
		t.Fatal("a response with no credential was accepted")
	}
}

func TestAnEmptyCodeIsRefusedWithoutACall(t *testing.T) {
	called := false
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { called = true }))
	defer server.Close()

	if _, err := enroll.Do(context.Background(), server.Client(), server.URL, enroll.Request{}); err == nil {
		t.Fatal("an empty code was accepted")
	}
	if called {
		t.Fatal("an empty code still reached the server")
	}
}
