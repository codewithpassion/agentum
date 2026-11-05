use super::*;
pub async fn checks(ctx: &Context<'_>) -> Vec<Check> {
    let Some(config) = ctx.config else {
        return vec![];
    };
    let url = match crate::enroll::endpoint(&config.server, "/", false) {
        Ok(url) => url,
        Err(error) => {
            return vec![Check {
                name: "server URL",
                level: Level::Problem,
                message: error.to_string(),
            }];
        }
    };
    let Ok(client) = crate::enroll::http_client() else {
        return vec![ctx.problem("TLS roots", Problem::Tls)];
    };
    match client.get(url).send().await {
        Ok(response) if response.status().is_redirection() => {
            vec![ctx.problem("server", Problem::Redirect)]
        }
        Ok(_) => vec![ok(
            "server",
            "Server reachable; doctor does not open a role socket because it would replace the running connection",
        )],
        Err(error) => vec![ctx.problem(
            "server",
            if error.is_connect() {
                Problem::Unreachable
            } else {
                Problem::Tls
            },
        )],
    }
}
