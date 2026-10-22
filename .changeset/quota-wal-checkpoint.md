---
"@sproutboat/runtime": patch
---

The storage quota counts a D1 database's WAL file, which can hold space the app has already freed. While the app is over its quota, the runtime now checkpoints and truncates each D1 database's WAL before measuring again, at most once a second. So `DELETE` then `VACUUM` is enough to get back under the quota, and the app no longer has to run a checkpoint itself. Databases under LTX capture are left alone: capture owns their checkpoints, and they stay frozen until the quota is raised or other data is deleted.
