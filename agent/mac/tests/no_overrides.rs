//! The agent must not read its settings location from the command line or the
//! environment (spec D2, V5): any use of `std::env` in the source is a failure.
use std::fs;
use std::path::Path;

fn sources(dir: &Path, out: &mut Vec<std::path::PathBuf>) {
    for entry in fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            sources(&path, out);
        } else if path.extension().map(|e| e == "rs").unwrap_or(false) {
            out.push(path);
        }
    }
}

#[test]
fn no_source_file_touches_arguments_or_the_environment() {
    let mut files = Vec::new();
    sources(&Path::new(env!("CARGO_MANIFEST_DIR")).join("src"), &mut files);
    assert!(files.len() > 10, "found only {} source files", files.len());
    let forbidden = ["env::args", "env::var", "env::vars", "env::args_os", "env::var_os", "env::current_dir", "getenv"];
    let mut problems = Vec::new();
    for file in files {
        let text = fs::read_to_string(&file).unwrap();
        for word in forbidden {
            if text.contains(word) {
                problems.push(format!("{} uses {word}", file.display()));
            }
        }
    }
    assert!(problems.is_empty(), "{problems:#?}");
}
