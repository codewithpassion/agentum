use agentum::{
    cli::{Cli, Command},
    instance::{self, Config, Paths, RunAs},
    wire::{self, MachineRole},
};
use clap::Parser;
use serde_json::Value;

fn config() -> Config {
    Config::new(
        "machine".into(),
        "Office".into(),
        "http://127.0.0.1:1".into(),
        vec![MachineRole::Computer],
        false,
        RunAs::Current,
    )
}
#[test]
fn real_ids_and_run_as_work_roots() {
    let temp = tempfile::tempdir().unwrap();
    let paths = Paths::new(temp.path().join("config"), temp.path().join("state"), false);
    let claim: Value = serde_json::from_str(include_str!(
        "../../../packages/protocol/fixtures/claim-response.json"
    ))
    .unwrap();
    let id = claim["agent"]["id"].as_str().unwrap();
    for run_as in [RunAs::Current, RunAs::User("dom".into()), RunAs::AgentUser] {
        let root = paths.work_root("office", &run_as);
        assert_eq!(
            root,
            if run_as == RunAs::AgentUser {
                "/var/lib/agentum/office/agent/work".into()
            } else {
                paths.state("office").join("work")
            }
        );
        assert_eq!(
            paths
                .agent_work("office", &run_as, "01ABC_workspace", id)
                .unwrap(),
            root.join("01ABC_workspace").join(id).join("work")
        );
        for bad in ["", "..", "../escape", "a/b", "a.b"] {
            assert!(paths.agent_work("office", &run_as, bad, id).is_err());
        }
    }
}
#[test]
fn select_and_names_are_unique_across_locations() {
    let temp = tempfile::tempdir().unwrap();
    let user = Paths::new(temp.path().join("user"), temp.path().join("us"), false);
    let system = Paths::new(temp.path().join("system"), temp.path().join("ss"), true);
    system.save("office", &config(), "ag_mach_test").unwrap();
    let locations = [user.clone(), system.clone()];
    assert!(instance::select(&locations, None).unwrap().0.system);
    assert!(instance::reserve(&locations, Some("office"), "").is_err());
    assert_eq!(
        instance::reserve(&locations, None, "Office").unwrap(),
        "office-2"
    );
    user.save("home", &config(), "ag_mach_test").unwrap();
    assert_eq!(instance::select(&locations, None).err().unwrap().code, 2);
    assert!(
        instance::select(&locations, Some("office"))
            .unwrap()
            .0
            .system
    );
    assert!(!instance::select(&locations, Some("home")).unwrap().0.system);
    assert_eq!(instance::free_display(&locations, temp.path()).unwrap(), 90);
    let mut c = config();
    c.computer.desktop_display = Some(90);
    user.save("display", &c, "ag_mach_test").unwrap();
    std::fs::write(temp.path().join(".X91-lock"), "locked").unwrap();
    assert_eq!(instance::free_display(&locations, temp.path()).unwrap(), 92);
}
#[test]
fn policy_overrides_can_disable_and_clear() {
    for prefix in [
        vec!["agentum", "run"],
        vec!["agentum", "service", "install"],
    ] {
        let cli = Cli::try_parse_from(prefix.into_iter().chain([
            "--no-allow-root",
            "--no-read-only",
            "--no-workdir-only",
            "--no-desktop",
            "--clear-allow",
            "--clear-deny",
            "--clear-allow-env",
        ]))
        .unwrap();
        let args = match cli.command {
            Command::Run(a) => a.computer,
            Command::Service {
                command: agentum::cli::ServiceCommand::Install(a),
            } => a.computer,
            _ => panic!(),
        };
        let mut c = config().computer;
        c.allow_root = true;
        c.read_only = true;
        c.workdir_only = true;
        c.desktop = true;
        c.allow = vec!["ls".into()];
        c.deny = vec!["rm".into()];
        c.allow_env = vec!["LANG".into()];
        c.apply(&args);
        assert!(!c.allow_root && !c.read_only && !c.workdir_only && !c.desktop);
        assert!(c.allow.is_empty() && c.deny.is_empty() && c.allow_env.is_empty());
    }
}
#[test]
fn hostname_uses_kernel() {
    assert_eq!(
        wire::hostname(),
        nix::unistd::gethostname().unwrap().to_string_lossy()
    );
}

#[test]
fn computer_hello_builder_matches_fixture() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../apps/agentum/testdata/protocol/client_to_server_hello.json"
    ))
    .unwrap();
    let expected: wire::ComputerHello = serde_json::from_value(fixture.clone()).unwrap();
    let hello = agentum::computer::hello(
        &expected.hostname,
        &expected.os,
        &expected.arch,
        &expected.version,
        &expected.run_as_user,
        &expected.workdir,
        expected.capabilities,
    );
    assert_eq!(serde_json::to_value(hello).unwrap(), fixture);
}

#[test]
fn config_fixes_use_real_paths_and_private_claude_preserves_daemon_text() {
    use agentum::privilege::{Problem, agent::private_claude};
    let path = std::path::Path::new("/etc/agentum/office");
    for p in [Problem::ConfigOwner, Problem::ConfigMode] {
        let report = p.explain_at("dom", "office", path);
        assert!(report.fix.contains("/etc/agentum/office"));
        assert!(!report.fix.contains("~/.config"));
    }
    let expected = "dom could not run /private/claude as agentum-office. The binary must be executable by agentum-office, so it cannot sit in a private home directory. Install it system-wide, then run install-service again with --claude <path>";
    assert_eq!(
        private_claude("dom", "office", "/private/claude").meaning,
        expected
    );
}

#[test]
fn system_namespace_is_traversable_but_instances_stay_private() {
    use std::os::unix::fs::PermissionsExt;
    let temp = tempfile::tempdir().unwrap();
    let paths = Paths::new(temp.path().join("etc"), temp.path().join("var"), true);
    paths.save("office", &config(), "ag_mach_secret").unwrap();
    for path in [&paths.config_root, &paths.state_root] {
        assert_eq!(
            std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o755
        );
    }
    assert_eq!(
        std::fs::metadata(paths.config("office"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o700
    );
}
