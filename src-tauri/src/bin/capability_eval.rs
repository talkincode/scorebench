use std::{env, path::PathBuf, process::ExitCode};

use scorebench_lib::capability;
use serde_json::{Map, Value};

const USAGE: &str = "Usage: capability_eval <case.yaml> [--min-pass-rate <0..1>] [--pretty]";

struct Cli {
    case_path: PathBuf,
    minimum_pass_rate: Option<f64>,
    pretty: bool,
}

enum ParseResult {
    Run(Cli),
    Help,
}

fn main() -> ExitCode {
    match parse_args(env::args().skip(1)) {
        Ok(ParseResult::Help) => {
            println!("{USAGE}");
            ExitCode::SUCCESS
        }
        Ok(ParseResult::Run(cli)) => run(cli),
        Err(error) => {
            eprintln!("error: {error}");
            eprintln!("{USAGE}");
            ExitCode::from(2)
        }
    }
}

fn run(cli: Cli) -> ExitCode {
    let report = match capability::evaluate_case_file(&cli.case_path) {
        Ok(report) => report,
        Err(error) => {
            eprintln!("error: {error}");
            return ExitCode::from(2);
        }
    };

    let threshold_met = cli
        .minimum_pass_rate
        .map(|minimum| report.meets_threshold(minimum));
    let mut output = match serde_json::to_value(&report) {
        Ok(Value::Object(object)) => object,
        Ok(_) => {
            eprintln!("error: capability report did not serialize as a JSON object");
            return ExitCode::from(2);
        }
        Err(error) => {
            eprintln!("error: cannot serialize capability report: {error}");
            return ExitCode::from(2);
        }
    };
    add_threshold_fields(&mut output, cli.minimum_pass_rate, threshold_met);

    let serialized = if cli.pretty {
        serde_json::to_string_pretty(&output)
    } else {
        serde_json::to_string(&output)
    };
    match serialized {
        Ok(json) => println!("{json}"),
        Err(error) => {
            eprintln!("error: cannot serialize capability report: {error}");
            return ExitCode::from(2);
        }
    }

    match threshold_met {
        Some(false) => ExitCode::FAILURE,
        Some(true) | None => ExitCode::SUCCESS,
    }
}

fn add_threshold_fields(
    output: &mut Map<String, Value>,
    minimum_pass_rate: Option<f64>,
    threshold_met: Option<bool>,
) {
    if let (Some(minimum), Some(met)) = (minimum_pass_rate, threshold_met) {
        output.insert("minimum_pass_rate".to_owned(), Value::from(minimum));
        output.insert("threshold_met".to_owned(), Value::from(met));
    }
}

fn parse_args(args: impl IntoIterator<Item = String>) -> Result<ParseResult, String> {
    let mut case_path = None;
    let mut minimum_pass_rate = None;
    let mut pretty = false;
    let mut args = args.into_iter();

    while let Some(argument) = args.next() {
        match argument.as_str() {
            "-h" | "--help" => return Ok(ParseResult::Help),
            "--pretty" => pretty = true,
            "--min-pass-rate" => {
                let raw = args
                    .next()
                    .ok_or_else(|| "--min-pass-rate requires a value".to_owned())?;
                minimum_pass_rate = Some(parse_threshold(&raw)?);
            }
            _ if argument.starts_with("--min-pass-rate=") => {
                let raw = argument
                    .strip_prefix("--min-pass-rate=")
                    .expect("prefix was checked");
                minimum_pass_rate = Some(parse_threshold(raw)?);
            }
            _ if argument.starts_with('-') => {
                return Err(format!("unknown option '{argument}'"));
            }
            _ if case_path.is_none() => case_path = Some(PathBuf::from(argument)),
            _ => return Err(format!("unexpected argument '{argument}'")),
        }
    }

    let case_path = case_path.ok_or_else(|| "a capability case path is required".to_owned())?;
    Ok(ParseResult::Run(Cli {
        case_path,
        minimum_pass_rate,
        pretty,
    }))
}

fn parse_threshold(raw: &str) -> Result<f64, String> {
    let value = raw
        .parse::<f64>()
        .map_err(|_| format!("invalid pass-rate threshold '{raw}'"))?;
    if !value.is_finite() || !(0.0..=1.0).contains(&value) {
        return Err(format!(
            "pass-rate threshold must be a finite number between 0 and 1, got '{raw}'"
        ));
    }
    Ok(value)
}
