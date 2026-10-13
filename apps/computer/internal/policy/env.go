package policy

import (
	"sort"
	"strings"
)

// The dynamic linker acts on these before any code here could look at them, so they are
// refused on every computer and no flag permits them.
var alwaysRefusedPrefixes = []string{"LD_", "DYLD_"}

// safeEnvNames is what a constrained computer accepts without being asked. Everything here
// affects presentation or names the session; none of it names a program to run.
var safeEnvNames = map[string]struct{}{
	"LANG":     {},
	"TZ":       {},
	"TERM":     {},
	"NO_COLOR": {},
	"CI":       {},
}

// safeEnvPrefixes are the families of the same.
var safeEnvPrefixes = []string{"LC_", "TFY_", "AGENTUM_SESSION_"}

// FilterEnv splits the environment the server asked for into what may be passed through and
// what is refused. The caller refuses the whole request when anything comes back refused,
// rather than silently dropping a variable the command may depend on.
//
// On a constrained computer this is an allowlist, not a denylist. A denylist of "variables
// that name a program" cannot be finished: HOME plus an uploaded .gitconfig, KUBECONFIG exec
// plugins, AWS_CONFIG_FILE credential_process, BASH_FUNC_*, RUSTC_WRAPPER and CC all get
// there, and each one found is evidence of the ones not yet found.
func (p *Policy) FilterEnv(overrides map[string]string) (accepted map[string]string, refused []string) {
	accepted = make(map[string]string, len(overrides))
	for name, value := range overrides {
		if p.envRefused(name) {
			refused = append(refused, name)
			continue
		}
		accepted[name] = value
	}
	sort.Strings(refused)
	return accepted, refused
}

func (p *Policy) envRefused(name string) bool {
	upper := strings.ToUpper(name)
	for _, prefix := range alwaysRefusedPrefixes {
		if strings.HasPrefix(upper, prefix) {
			return true
		}
	}
	if !p.restricted {
		// Nothing is constrained here, so the server can already run whatever it likes and
		// refusing a variable would be theatre.
		return false
	}
	if p.envAllowed(name) {
		return false
	}
	if _, safe := safeEnvNames[upper]; safe {
		return false
	}
	for _, prefix := range safeEnvPrefixes {
		if strings.HasPrefix(upper, prefix) {
			return false
		}
	}
	return true
}

// envAllowed matches what the operator named. A trailing * makes it a prefix, which is how
// a family like GIT_CONFIG_* is granted.
func (p *Policy) envAllowed(name string) bool {
	if _, exact := p.allowedEnv[name]; exact {
		return true
	}
	for _, prefix := range p.allowedEnvPrefixes {
		if strings.HasPrefix(name, prefix) {
			return true
		}
	}
	return false
}
