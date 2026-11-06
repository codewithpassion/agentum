use std::process::Command;
fn main() {
    println!("cargo:rerun-if-env-changed=AGENTUM_VERSION");
    // Release publishing supplies the exact manifest version. Local builds follow git HEAD.
    println!("cargo:rerun-if-changed=../../.git");
    for name in ["HEAD", "refs/heads/"] {
        if let Ok(output) = Command::new("git")
            .args(["rev-parse", "--git-path", name])
            .output()
            && output.status.success()
        {
            println!(
                "cargo:rerun-if-changed={}",
                String::from_utf8_lossy(&output.stdout).trim()
            );
        }
    }
    let version = std::env::var("AGENTUM_VERSION").unwrap_or_else(|_| {
        let sha = Command::new("git")
            .args(["rev-parse", "--short=8", "HEAD"])
            .output()
            .ok()
            .filter(|output| output.status.success())
            .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_owned())
            .unwrap_or_else(|| "unknown".into());
        format!("{}+{sha}", env!("CARGO_PKG_VERSION"))
    });
    println!("cargo:rustc-env=AGENTUM_VERSION={version}");
}
