# Synthetic shipping calculator

This disposable project contains invented code and no external services or data.
An already available Node.js 22 or newer runs the checks. No install is needed.

Shipping costs 499 cents for subtotals below 5000 cents and is free for subtotals
of 5000 cents or more. Inputs are nonnegative integer cents; other inputs are out
of scope. One boundary case is broken.

Run `node shipping.test.js`. Repair `shipping.js` with the smallest change that
implements this policy. Keep the tests and this README unchanged. Run the checks
again and report the command, exit code, before/after output and changed line.

Work only in this selected disposable repository. Do not install dependencies,
use the network, read other workspaces, change permissions, commit, push or open
a pull request. Stop if the workspace or available runtime differs from what
the tester approved. A passing explanation without a tested code change is not
completion.
