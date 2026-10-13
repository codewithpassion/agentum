package policy_test

import (
	"slices"
	"testing"

	"agentum.dev/computer/internal/policy"
)

func refusedNames(t *testing.T, p *policy.Policy, names ...string) []string {
	t.Helper()
	overrides := make(map[string]string, len(names))
	for _, name := range names {
		overrides[name] = "value"
	}
	_, refused := p.FilterEnv(overrides)
	return refused
}

// The dynamic linker runs these before anything on this side can look at them, so there is no
// mode and no flag in which they are accepted.
func TestLoaderVariablesAreAlwaysRefused(t *testing.T) {
	loaders := []string{"LD_PRELOAD", "LD_LIBRARY_PATH", "LD_AUDIT", "DYLD_INSERT_LIBRARIES"}
	for _, options := range []policy.Options{
		{},
		{Allow: []string{`.*`}},
		{AllowEnv: loaders},
		{AllowEnv: []string{"LD_*", "DYLD_*"}},
	} {
		p := mustNew(t, options)
		refused := refusedNames(t, p, loaders...)
		if len(refused) != len(loaders) {
			t.Fatalf("with %+v the loader variables were accepted: refused %v", options, refused)
		}
	}
}

// A constrained computer uses an allowlist. A denylist of "variables that name a program"
// cannot be finished — HOME with an uploaded .gitconfig, KUBECONFIG exec plugins,
// AWS_CONFIG_FILE credential_process, BASH_FUNC_*, RUSTC_WRAPPER, CC — and every one found
// is evidence of the ones not found yet.
func TestAConstrainedComputerAllowlistsTheEnvironment(t *testing.T) {
	reachable := []string{
		// The families the earlier denylist named.
		"PATH", "BASH_ENV", "ENV", "IFS", "SHELLOPTS", "PS4", "PROMPT_COMMAND",
		"GIT_SSH_COMMAND", "GIT_CONFIG_GLOBAL", "PAGER", "EDITOR",
		"PYTHONSTARTUP", "PYTHONPATH", "NODE_OPTIONS", "PERL5OPT", "RUBYOPT",
		// The ones it did not, which is the point.
		"HOME", "XDG_CONFIG_HOME", "KUBECONFIG", "AWS_CONFIG_FILE",
		"BASH_FUNC_ls%%", "JAVA_TOOL_OPTIONS", "PYTHONUSERBASE", "PERL5LIB",
		"RUBYLIB", "NODE_PATH", "npm_config_prefix", "CC", "MAKEFLAGS",
		"RUSTC_WRAPPER", "SSL_CERT_FILE", "CURL_HOME",
	}
	for _, options := range []policy.Options{
		{Allow: []string{`git .*`}},
		{Deny: []string{`rm`}},
		{ReadOnly: true},
		{WorkdirOnly: true, Workdir: t.TempDir()},
	} {
		p := mustNew(t, options)
		refused := refusedNames(t, p, reachable...)
		if len(refused) != len(reachable) {
			var accepted []string
			for _, name := range reachable {
				if !slices.Contains(refused, name) {
					accepted = append(accepted, name)
				}
			}
			t.Fatalf("with %+v these were accepted: %v", options, accepted)
		}
	}
}

// The built-in safe set is what a session legitimately needs and none of it names a program.
func TestTheSafeSetPassesOnAConstrainedComputer(t *testing.T) {
	p := mustNew(t, policy.Options{Allow: []string{`git .*`}})
	safe := []string{
		"LANG", "LC_ALL", "LC_CTYPE", "TZ", "TERM", "NO_COLOR", "CI",
		"TFY_SESSION_ID", "TFY_ANYTHING", "AGENTUM_SESSION_DIR",
	}
	if refused := refusedNames(t, p, safe...); len(refused) != 0 {
		t.Fatalf("the safe set was refused: %v", refused)
	}
}

// An unconstrained computer passes the server's environment through: it can already run
// anything, so refusing PATH would be theatre.
func TestAnUnconstrainedComputerPassesEnvironmentThrough(t *testing.T) {
	p := mustNew(t, policy.Options{})
	passed := []string{"PATH", "HOME", "GIT_SSH_COMMAND", "KUBECONFIG", "ANYTHING_ELSE"}
	if refused := refusedNames(t, p, passed...); len(refused) != 0 {
		t.Fatalf("an unconstrained computer refused %v", refused)
	}
	if refused := refusedNames(t, p, "LD_PRELOAD"); len(refused) != 1 {
		t.Fatal("LD_PRELOAD passed on an unconstrained computer")
	}
}

// The escape hatch, in both forms. A skill that needs git credentials is granted
// GIT_CONFIG_*; Code Mode will need PYTHONPATH.
func TestAllowEnvNamesAndPrefixes(t *testing.T) {
	p := mustNew(t, policy.Options{
		Allow:    []string{`git .*`},
		AllowEnv: []string{"PYTHONPATH", "GIT_CONFIG_*"},
	})
	if refused := refusedNames(t, p, "PYTHONPATH", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"); len(refused) != 0 {
		t.Fatalf("--allow-env was not honoured: %v", refused)
	}
	// The prefix grants its family and nothing beyond it.
	if refused := refusedNames(t, p, "GIT_SSH_COMMAND", "PYTHONSTARTUP"); len(refused) != 2 {
		t.Fatalf("--allow-env widened past what it named: %v", refused)
	}
}

func TestOrdinaryVariablesAreRefusedWhenConstrained(t *testing.T) {
	p := mustNew(t, policy.Options{Allow: []string{`.*`}})
	accepted, refused := p.FilterEnv(map[string]string{
		"TFY_SESSION_ID": "sess-1",
		"MY_APP_TOKEN":   "value",
	})
	if len(refused) != 1 || refused[0] != "MY_APP_TOKEN" {
		t.Fatalf("refused = %v", refused)
	}
	if accepted["TFY_SESSION_ID"] != "sess-1" {
		t.Fatalf("accepted = %v", accepted)
	}
}

// Names are matched case-insensitively against the safe set: on a lookup that ignores case
// the shell would still find ld_preload, and matching one spelling invites the bypass.
func TestMatchingIgnoresCase(t *testing.T) {
	p := mustNew(t, policy.Options{Allow: []string{`.*`}})
	if refused := refusedNames(t, p, "ld_preload"); len(refused) != 1 {
		t.Fatalf("a lower-cased loader variable got through: %v", refused)
	}
	if refused := refusedNames(t, p, "lang", "lc_all"); len(refused) != 0 {
		t.Fatalf("a lower-cased safe variable was refused: %v", refused)
	}
}
