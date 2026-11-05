pub mod approvals;
pub mod claude;
pub mod cli;
pub mod computer;
pub mod desktop;
pub mod doctor;
pub mod enroll;
pub mod files;
pub mod instance;
pub mod library;
pub mod privilege;
pub mod relay;
pub mod runs;
pub mod service;
pub mod wire;

#[derive(Debug, thiserror::Error)]
#[error("{message}")]
pub struct Error {
    pub code: u8,
    pub message: String,
}
impl Error {
    pub fn new(code: u8, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}
pub type Result<T> = std::result::Result<T, Error>;
pub const VERSION: &str = env!("AGENTUM_VERSION");
