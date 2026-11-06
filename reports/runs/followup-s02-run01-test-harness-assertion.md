# Follow-up scenario 2 — test-harness assertion correction

The isolated sale and CASH return completed; the test script then asserted `ret.cashRefunded`, a response property the service does not expose, so the test harness received `undefined` and failed with `NaN !== 100000`. This was a test assertion error, not yet a scenario result. The rerun checks the documented `refundAmount` and raw `CashMovement` instead. The database was temporary SQLite only and was discarded with the test directory.
