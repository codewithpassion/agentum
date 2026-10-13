package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"

	"agentum.dev/computer/internal/audit"
	"agentum.dev/computer/internal/protocol"
	"agentum.dev/computer/internal/state"
)

// statusReport is what `status` prints. It is local only: nothing here needs the server, so
// a machine with no network still answers.
type statusReport struct {
	Version      string                `json:"version"`
	StateDir     string                `json:"state_dir"`
	Enrolled     bool                  `json:"enrolled"`
	URL          string                `json:"url,omitempty"`
	ComputerID   string                `json:"computer_id,omitempty"`
	Hostname     string                `json:"hostname"`
	OS           string                `json:"os"`
	Arch         string                `json:"arch"`
	RunAsUser    string                `json:"run_as_user"`
	Capabilities protocol.Capabilities `json:"capabilities"`
	AuditLog     string                `json:"audit_log"`
	// PendingGroups is how many commands a previous run left behind for the next start to
	// sweep; anything other than zero means the daemon was killed mid-command.
	PendingGroups int `json:"pending_groups"`
}

func runStatus(args []string) int {
	set := flag.NewFlagSet("status", flag.ContinueOnError)
	stateDir := set.String("state-dir", state.DefaultDir(), "where the credential and config are kept")
	asJSON := set.Bool("json", false, "print the report as JSON")
	if err := set.Parse(args); err != nil {
		return exitUsage
	}

	report := statusReport{
		Version:       version,
		StateDir:      *stateDir,
		Enrolled:      state.IsEnrolled(*stateDir),
		Hostname:      state.Hostname(""),
		OS:            state.OS(),
		Arch:          state.Arch(),
		RunAsUser:     state.RunAsUser(),
		Capabilities:  state.DetectCapabilities(),
		AuditLog:      filepath.Join(*stateDir, audit.FileName),
		PendingGroups: countPendingGroups(*stateDir),
	}
	config, err := state.LoadConfig(*stateDir)
	if err != nil && !errors.Is(err, state.ErrNotEnrolled) {
		fmt.Fprintf(os.Stderr, "could not read the config: %v\n", err)
		return exitFailure
	}
	report.URL = config.URL
	report.ComputerID = config.ComputerID
	if config.Name != "" {
		report.Hostname = config.Name
	}

	if *asJSON {
		encoded, err := json.MarshalIndent(report, "", "  ")
		if err != nil {
			fmt.Fprintf(os.Stderr, "could not render the report: %v\n", err)
			return exitFailure
		}
		fmt.Println(string(encoded))
	} else {
		printStatus(report)
	}
	if !report.Enrolled {
		return exitNotReady
	}
	return exitOK
}

func printStatus(report statusReport) {
	fmt.Printf("version       %s\n", report.Version)
	fmt.Printf("state dir     %s\n", report.StateDir)
	fmt.Printf("enrolled      %t\n", report.Enrolled)
	if report.ComputerID != "" {
		fmt.Printf("computer id   %s\n", report.ComputerID)
	}
	if report.URL != "" {
		fmt.Printf("server        %s\n", report.URL)
	}
	fmt.Printf("hostname      %s\n", report.Hostname)
	fmt.Printf("platform      %s/%s\n", report.OS, report.Arch)
	fmt.Printf("run as        %s\n", report.RunAsUser)
	fmt.Printf("python3       %t\n", report.Capabilities.Python3)
	fmt.Printf("git           %t\n", report.Capabilities.Git)
	fmt.Printf("skills        %t\n", report.Capabilities.Skills)
	fmt.Printf("audit log     %s\n", report.AuditLog)
	if report.PendingGroups > 0 {
		fmt.Printf("left behind   %d command group(s) from a previous run; the next `run` reaps them\n", report.PendingGroups)
	}
	if !report.Enrolled {
		fmt.Println("\nNot enrolled. Run: agentum-computer enroll --url <base> --code <code>")
	}
}

func countPendingGroups(stateDir string) int {
	entries, err := os.ReadDir(filepath.Join(stateDir, "running"))
	if err != nil {
		return 0
	}
	return len(entries)
}
