# Removing modules

The cloud and store modules can be removed from a database while auth (profiles, roles, bans, the audit log, API tokens, paired devices and the QA account flag) stays in place. Cloud depends only on auth and can go on its own:

```
psql "$DB_URL" -f drop_cloud.sql
psql "$DB_URL" -f drop_store.sql
psql "$DB_URL" -f drop_sxlock.sql
psql "$DB_URL" -f drop_bug_reports.sql
```

`drop_sxlock.sql` removes locked projects: the account keys go, so every `.sxlock` file made on that database stops opening.

`drop_bug_reports.sql` removes the crash and bug reports table, `submit_bug_report` and the `bug-reports` bucket (only when empty).

`drop_store.sql` removes the `uploads-quarantine` and `listing-files` buckets only when they are empty. Delete stored files through the Storage API before dropping the store.

To leave a module out of a new database, delete its migration and its seed file (`seed/store.sql`, where it has one) and remove the seed path from `config.toml`.

`check-drop.sh` runs every drop script inside a transaction on the local stack, checks that only the auth tables (`profiles`, `api_tokens`, `api_token_usage`, `account_deletions`, `audit_log`, `paired_devices`, `qa_accounts`) remain in the public schema, that roles still work and that a new sign-up still gets a profile, and then rolls back.
