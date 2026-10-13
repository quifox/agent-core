use std::ffi::OsString;

pub fn engine_arguments(arguments: impl IntoIterator<Item = OsString>) -> Vec<OsString> {
    let mut arguments = arguments.into_iter();
    let mut result = Vec::new();
    while let Some(argument) = arguments.next() {
        if argument == "--workspace" || argument == "--root" {
            if let Some(value) = arguments.next() {
                result.extend([argument, value]);
            }
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::engine_arguments;
    use std::ffi::OsString;

    #[test]
    fn forwards_explicit_host_paths_without_splitting_spaces_or_platform_arguments() {
        let input = ["-psn_0_1", "--workspace", "/synthetic/project with spaces", "--root", "/synthetic/profile"];
        assert_eq!(engine_arguments(input.map(OsString::from)), input[1..].iter().map(OsString::from).collect::<Vec<_>>());
        assert!(engine_arguments([OsString::from("--workspace")]).is_empty());
    }
}
