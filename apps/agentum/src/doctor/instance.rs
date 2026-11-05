use super::*;
pub fn checks(ctx: &Context<'_>) -> Vec<Check> {
    if matches!(ctx.paths.config(ctx.name).try_exists(), Ok(false)) {
        return vec![Check {
            name: "instance",
            level: Level::Problem,
            message: "Not enrolled. Enrol with: agentum enroll --url https://<server> --code-stdin"
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
