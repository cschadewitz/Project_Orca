- **examples:** The beta first-job fixture (`examples/beta-first-job/fixture.js`) runs on Windows.
  It pointed Git's global configuration at `NUL` there, which Git for Windows refuses as a
  config path; it now uses `/dev/null`, which Git for Windows also reads as the null device.
