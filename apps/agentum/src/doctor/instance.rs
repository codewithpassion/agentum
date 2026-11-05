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
    match ctx.paths.load(ctx.name) {
        Ok(_) => vec![ok(
            "instance",
            "Config and credential are private and owned by this user",
        )],
        Err(error) => vec![Check {
            name: "instance",
            level: Level::Problem,
            message: error.to_string(),
        }],
    }
}
