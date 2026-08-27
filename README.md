# jpi-subagents (deprecated)

This plugin moved into the consolidated [jpi](https://github.com/josh-sola/jpi)
plugin as its `subagents` module. This repo now ships only a startup warning.

To switch:

```
pi install git:github.com/josh-sola/jpi
pi remove git:github.com/josh-sola/jpi-subagents
```

The module can be disabled via `enabled #false` in the `subagents { }` stanza of
`jpi.kdl`.
