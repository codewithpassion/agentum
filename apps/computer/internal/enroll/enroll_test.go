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
	"strings"
	"testing"

	"harbourmaster.dev/computer/internal/enroll"
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
		"https://hm.example.com":  "https://hm.example.com/api/machines/enroll",
		"https://hm.example.com/": "https://hm.example.com/api/machines/enroll",
		// Plaintext to this machine is the development case and stays allowed.
		"http://127.0.0.1:8787": "http://127.0.0.1:8787/api/machines/enroll",
		// A websocket scheme names the same server; the enrollment call is still HTTP.
		"wss://hm.example.com": "https://hm.example.com/api/machines/enroll",
	} {
		got, err := enroll.URL(input)
		if err != nil {
			t.Fatalf("URL(%q): %v", input, err)
		}
		if got != want {
			t.Fatalf("URL(%q) = %q, want %q", input, got, want)
		}
	}
	for _, bad := range []string{"", "hm.example.com", "http://hm.example.com"} {
		if _, err := enroll.URL(bad); err == nil {
			t.Fatalf("URL(%q) was accepted", bad)
		}
	}
}

// A 307 or 308 re-sends the body, so following a redirect would hand the single-use code to
// wherever the first server pointed — including, on an https-to-http hop, the network.
func TestRedirectsAreRefused(t *testing.T) {
	final := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		_, _ = writer.Write([]byte(`{"machineId":"c","credential":"hm_mach_test"}`))
	}))
	defer final.Close()
	redirector := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		http.Redirect(writer, request, final.URL+enroll.Path, http.StatusTemporaryRedirect)
	}))
	defer redirector.Close()

	_, err := enroll.Do(context.Background(), enroll.DefaultClient(), redirector.URL, enroll.Request{Code: "hm_enr_code"})
	if !errors.Is(err, enroll.ErrRedirected) {
		t.Fatalf("error = %v, want ErrRedirected", err)
	}
}

// The request and response fixtures encode the V6.1 computer enrollment contract.
func TestSuccessfulEnrollmentMatchesTheFixtures(t *testing.T) {
	var received []byte
	var receivedPath string
	var method string
	var contentType string
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		receivedPath = request.URL.Path
		method = request.Method
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
	if method != http.MethodPost {
		t.Fatalf("method = %q", method)
	}
	if receivedPath != "/api/machines/enroll" {
		t.Fatalf("posted to %q, want %q", receivedPath, enroll.Path)
	}
	if contentType != "application/json" {
		t.Fatalf("content type = %q", contentType)
	}

	var sent map[string]any
	var expectedRequest map[string]any
	if err := json.Unmarshal(fixture(t, "request.json"), &expectedRequest); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(received, &sent); err != nil {
		t.Fatalf("decode what was sent: %v", err)
	}
	if !reflect.DeepEqual(sent, expectedRequest) {
		t.Fatalf("sent %+v, want %+v", sent, want)
	}

	var expected enroll.Result
	if err := json.Unmarshal(fixture(t, "response.json"), &expected); err != nil {
		t.Fatalf("decode the response fixture: %v", err)
	}
	if result != expected {
		t.Fatalf("result = %+v, want %+v", result, expected)
	}
}

// A 401 is the one failure the operator can act on, so it gets its own error.
func TestRejectedCodeIsItsOwnError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.WriteHeader(http.StatusUnauthorized)
		_, _ = writer.Write([]byte(`{"error":"unauthorized"}`))
	}))
	defer server.Close()

	_, err := enroll.Do(context.Background(), server.Client(), server.URL, enroll.Request{Code: "hm_enr_nope"})
	if !errors.Is(err, enroll.ErrCodeRejected) {
		t.Fatalf("error = %v, want ErrCodeRejected", err)
	}
}

func TestOtherFailuresCarryTheStatus(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.WriteHeader(http.StatusBadGateway)
		_, _ = writer.Write([]byte(`{"error":"upstream is down"}`))
	}))
	defer server.Close()

	_, err := enroll.Do(context.Background(), server.Client(), server.URL, enroll.Request{Code: "hm_enr_x"})
	if err == nil || !strings.Contains(err.Error(), "502") || !strings.Contains(err.Error(), "upstream is down") || errors.Is(err, enroll.ErrCodeRejected) {
		t.Fatalf("error = %v", err)
	}
}

func TestAResponseWithoutACredentialIsRefused(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		_, _ = writer.Write([]byte(`{"machineId":"cmp_1"}`))
	}))
	defer server.Close()

	if _, err := enroll.Do(context.Background(), server.Client(), server.URL, enroll.Request{Code: "hm_enr_x"}); err == nil {
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

func TestUnreachableServer(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	server.Close()
	if _, err := enroll.Do(context.Background(), server.Client(), server.URL, enroll.Request{Code: "hm_enr_test"}); err == nil {
		t.Fatal("unreachable server accepted")
	}
}

// The server issues ag_ codes and credentials after the rename, and hm_ ones from before stay
// valid, so the client takes both and refuses anything else.
func TestBothTokenPrefixesAreAccepted(t *testing.T) {
	for _, pair := range [][2]string{{"ag_enr_code", "ag_mach_new"}, {"hm_enr_code", "hm_mach_old"}, {"ag_enr_code", "hm_mach_old"}} {
		t.Run(pair[0]+"/"+pair[1], func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				_, _ = w.Write([]byte(`{"machineId":"m","credential":"` + pair[1] + `"}`))
			}))
			defer server.Close()
			result, err := enroll.Do(context.Background(), server.Client(), server.URL, enroll.Request{Code: pair[0]})
			if err != nil || result.Credential != pair[1] {
				t.Fatalf("result = %+v, error = %v", result, err)
			}
		})
	}
	if _, err := enroll.Do(context.Background(), nil, "https://example.invalid", enroll.Request{Code: "xx_enr_code"}); err == nil {
		t.Fatal("a code with another prefix was accepted")
	}
}

func TestMalformedSuccess(t *testing.T) {
	for _, body := range []string{`not json`, `{"machineId":"m"}`, `{"machineId":"m","credential":"wrong_prefix"}`, `{"data":{"machineId":"m","credential":"hm_mach_old"}}`} {
		t.Run(body, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte(body)) }))
			defer server.Close()
			if _, err := enroll.Do(context.Background(), server.Client(), server.URL, enroll.Request{Code: "hm_enr_test"}); err == nil {
				t.Fatal("malformed response accepted")
			}
		})
	}
}
