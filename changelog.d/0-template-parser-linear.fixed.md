- **core:** the prompt template parser scans tags and `{{#each}}` headers in linear time. A
  long run of spaces inside an `{{#each}}` tag, or many unclosed `{{!--`, could hold the
  daemon for seconds to minutes while it validated or previewed a template.
