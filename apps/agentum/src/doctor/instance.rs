use super::*;
pub fn checks(ctx: &Context<'_>) -> Vec<Check> {
    if matches!(ctx.paths.config(ctx.name).try_exists(), Ok(false)) {
        return vec![Check {
            name: "instance",
            level: Level::Problem,
            message: "Not enrolled\nWhy: No enrolment is saved for this instance.\nFix: agentum enroll --url https://<server> --code-stdin"
                .into(),
        }];
    }
    match crate::service::read_config(ctx.paths, ctx.name, "doctor") {
        Ok(_) => vec![ok(
            "instance",
            "Config and credential have private modes and an authorised owner",
        )],
        Err(error) => vec![Check {
            name: "instance",
            level: Level::Problem,
            message: error.to_string(),
        }],
    }
}

pub fn connections(ctx: &Context<'_>) -> Vec<Check> {
    let Some(config) = ctx.config else {
        return vec![];
    };
    config
        .roles
        .iter()
        .filter_map(|role| {
            let name = match role {
                crate::wire::MachineRole::AgentHost => "agent_host",
                crate::wire::MachineRole::Computer => "computer",
            };
            let state = std::fs::read(
                ctx.paths
                    .state(ctx.name)
                    .join(format!("connection-{name}.json")),
            )
            .ok()?;
            let state: serde_json::Value = serde_json::from_slice(&state).ok()?;
            if state["status"] != "stopped" {
                return None;
            }
            let reason = state["reason"]
                .as_str()
                .filter(|reason| !reason.is_empty())?;
            Some(Check {
                name: match role {
                    crate::wire::MachineRole::AgentHost => "agent_host connection",
                    crate::wire::MachineRole::Computer => "computer connection",
                },
                level: Level::Problem,
                message: reason.into(),
            })
        })
        .collect()
}
