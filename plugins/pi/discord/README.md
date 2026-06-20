# @agents-comm-bus/pi-discord

Pi host extension for agents-comm-bus — discord comm. Bundles the shared [`@agents-comm-bus/pi-core`](https://github.com/remingtonspaz/agents-comm-bus-pi-core).

## Install

```bash
pi install git:github.com/remingtonspaz/agents-comm-bus-pi-discord
```

## Prerequisites

- An `agents-comm-bus` daemon registered with `agent=pi`:
  ```bash
  agents-comm account-add --project <path> --agent pi --account-label main --comm discord --bot-token <token>
  ```
