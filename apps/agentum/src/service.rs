//! Filled in by the next role/service task; RC.2 exposes an explicit failure.
use crate::{Error, Result};
pub fn run() -> Result<()> {
    Err(Error::new(1, "service: not built yet"))
}
