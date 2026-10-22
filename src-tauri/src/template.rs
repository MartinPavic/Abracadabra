//! Single-pass `{placeholder}` substitution. Chained `str::replace` calls would
//! expand placeholders that appear inside an already substituted value (e.g. an
//! issue title containing `{worker_summary}`).

pub fn substitute(template: &str, values: &[(&str, &str)]) -> String {
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(start) = rest.find('{') {
        out.push_str(&rest[..start]);
        let after = &rest[start..];
        let Some(end) = after.find('}') else {
            out.push_str(after);
            return out;
        };
        let name = &after[1..end];
        if name.contains('{') {
            // Not a placeholder; the inner `{` may start one.
            out.push('{');
            rest = &after[1..];
            continue;
        }
        match values.iter().find(|(key, _)| *key == name) {
            Some((_, value)) => out.push_str(value),
            None => out.push_str(&after[..=end]),
        }
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replaces_known_placeholders_and_keeps_unknown_ones() {
        assert_eq!(substitute("{a}-{b}-{c}", &[("a", "1"), ("b", "2")]), "1-2-{c}");
    }

    #[test]
    fn does_not_expand_placeholders_inside_values() {
        let out = substitute("{title} / {summary}", &[("title", "{summary}"), ("summary", "S")]);
        assert_eq!(out, "{summary} / S");
    }

    #[test]
    fn tolerates_stray_braces() {
        assert_eq!(substitute("a { b {x} }", &[("x", "1")]), "a { b 1 }");
        assert_eq!(substitute("open {", &[]), "open {");
        assert_eq!(substitute("{{x}}", &[("x", "1")]), "{1}");
    }
}
