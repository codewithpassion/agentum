package policy

import (
	"os"
	"path/filepath"
	"testing"
)

// within compares by identity, not by string. A textual comparison is case-sensitive while
// APFS and NTFS are not, so on macOS `~/.AGENTUM/credential` reaches the same file as
// `~/.agentum/credential` and would read as "outside the state directory". That case
// cannot be reproduced on a case-sensitive filesystem, so the test exercises the mechanism:
// two different strings naming the same directory.
func TestWithinComparesIdentityNotText(t *testing.T) {
	parent := t.TempDir()
	real := filepath.Join(parent, "state")
	if err := os.MkdirAll(filepath.Join(real, "running"), 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	alias := filepath.Join(parent, "alias")
	if err := os.Symlink(real, alias); err != nil {
		t.Skipf("symlinks are not available here: %v", err)
	}

	// The root is named one way and the candidate another; only identity connects them.
	if !within(alias, filepath.Join(real, "credential")) {
		t.Fatal("a candidate inside the root read as outside it")
	}
	if !withinLexically(real, filepath.Join(real, "credential")) {
		t.Fatal("the lexical fallback is broken")
	}
	if withinLexically(alias, filepath.Join(real, "credential")) {
		t.Fatal("the lexical comparison unexpectedly matched; this test proves nothing")
	}
}

// A file that does not exist yet is the normal case for an upload, so the walk has to work
// from the deepest ancestor that does.
func TestWithinHandlesAPathThatDoesNotExistYet(t *testing.T) {
	root := t.TempDir()
	if !within(root, filepath.Join(root, "a", "b", "c", "new.txt")) {
		t.Fatal("a path about to be created read as outside the root")
	}
	if within(root, filepath.Join(t.TempDir(), "elsewhere.txt")) {
		t.Fatal("a path outside the root read as inside it")
	}
}

func TestWithinMatchesTheRootItself(t *testing.T) {
	root := t.TempDir()
	if !within(root, root) {
		t.Fatal("the root is not within itself")
	}
}

// A sibling whose name merely starts with the root's must not count, by either route.
func TestWithinRejectsAPrefixSibling(t *testing.T) {
	parent := t.TempDir()
	root := filepath.Join(parent, "work")
	sibling := filepath.Join(parent, "work-evil")
	for _, dir := range []string{root, sibling} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatalf("mkdir: %v", err)
		}
	}
	if within(root, filepath.Join(sibling, "file")) {
		t.Fatal("a prefix sibling read as inside the root")
	}
	if withinLexically(root, filepath.Join(sibling, "file")) {
		t.Fatal("the lexical fallback accepted a prefix sibling")
	}
}

// When the root does not exist there is nothing to compare identities against, so the
// comparison falls back to components rather than silently allowing everything.
func TestWithinFallsBackWhenTheRootIsMissing(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "never-created")
	if !within(missing, filepath.Join(missing, "child")) {
		t.Fatal("the fallback refused a child of the root")
	}
	if within(missing, filepath.Join(t.TempDir(), "elsewhere")) {
		t.Fatal("the fallback accepted a path outside the root")
	}
}
