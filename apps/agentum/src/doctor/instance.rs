use super::*;
pub fn checks(ctx: &Context<'_>) -> Vec<Check> {
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
