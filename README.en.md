<p align="center">
  <img src="docs/brand/mark.png" width="88" alt="">
</p>

<h1 align="center">proxybox</h1>

<p align="center">A solid body with one bore through it: traffic has exactly one way out, and it is ours.</p>

<p align="center"><a href="https://gerrux.github.io/proxybox/">Site</a> · <a href="https://github.com/Gerrux/proxybox/releases">Download</a> · <a href="docs/">Docs</a> · <a href="docs/brand.md">Brand</a></p>

<p align="center"><a href="README.md">Русский</a> · <b>English</b> · <a href="README.fa.md">فارسی</a> · <a href="README.zh.md">简体中文</a> · <a href="README.tr.md">Türkçe</a> · <a href="README.id.md">Bahasa Indonesia</a></p>

**Fail-closed control over outbound traffic.** The programs you pick reach the
network only through your tunnel; no tunnel, no network. Traffic from every
other application is left alone entirely.

Windows 10/11. A Rust core in workspace crates, a service on top of it, a Tauri
2.x desktop shell, and a Vite + React + TS + Tailwind frontend. The interface,
the service and the installer all speak six languages.

The original spec (Russian) — [proxybox-prompt.md](proxybox-prompt.md).

![The proxybox window](docs/interface.png)

State is the main thing the window shows, which is why it takes the top. Below
the heading the path itself is drawn: from the selected applications to the
network. While the tunnel is up, dashes travel along it; when there is no
tunnel, the conduit is cut and still.

![No tunnel — access closed](docs/interface-failclosed.png)

Closed access is amber, not red, and that is not a matter of taste: this is how
fail-closed is supposed to look **when it is working** — in red it would read as
an application failure. Red is left for exactly one thing: the service is not
answering or the rules did not apply, meaning something really broke and a human
is needed. Application rows carry the same colour — what is happening to each of
them right now is visible where the list is.

There are six languages: Russian, English, Persian, Chinese, Turkish and
Indonesian. The switch lives in the settings, behind the title-bar button; the
language is kept by the service, so the journal switches together with the
window.

![English interface](docs/interface-en.png)

## The invariant

Private mode on + tunnel not confirmed = the selected applications have no
network. Intermediate states with direct access do not exist, and there are no
bypass rules. Everything else in the architecture follows from this.

There are two scopes, chosen on the window header at the left end of the
conduit. **Whitelist** — only the selected applications have network, and only
through the tunnel. **Whole machine** — no selection at all: traffic with no
process behind it goes into the tunnel too, service, driver, DNS. The invariant
is the same, only who it applies to changes.

The selection does not live in the tunnel config but in the Windows firewall,
and it happens on `connect`, before any TUN. The sing-box config is byte for
byte the same in both scopes, and there is no route past the tunnel in it at
all — which is why switching scope and editing the application list do not
restart the tunnel: an open SSH session survives them.

```
                 yes ────────────► passes issued, traffic goes into the tunnel
SOCKS5 probe ────┤
                 no  ────────────► no passes: the selected apps have no network either
```

How it works inside — [docs/how-it-works.md](docs/how-it-works.md).

## Install

A ready installer is in the [releases](https://github.com/Gerrux/proxybox/releases).
NSIS, per-machine, six languages: it puts the window, the service, the CLI and
sing-box into one folder and registers the `proxybox` service under LocalSystem
with autostart. The product has no network of its own — the tunnel is your own
server.

Details, updates and living next to somebody else's VPN — [docs/install.md](docs/install.md).

## Quick start on Windows

Double-click `run.bat` — it checks the environment, downloads sing-box if
needed, installs dependencies and offers to: start the service with the app
window, start the service with the interface in a browser, build the installer,
run the tests, or check the environment (`doctor`).

The service needs administrator rights — TUN and firewall rules cannot be raised
without them; `run.bat` warns about this when started without them.

## Principles

- **Fail-closed:** intermediate states with direct access do not exist. No
  tunnel — DROP. No bypass rules.
- **Privileges live in the service only.** The GUI and the CLI are thin
  `core-ipc` clients running as an ordinary user, with no state of their own. On
  Windows the link is a named pipe with an access list: SYSTEM and
  administrators in full, interactive users read and write, low-integrity
  processes (browser sandboxes) not at all. The state directory is locked the
  same way: `state.json` holds the passwords and keys of every profile.
- **One outbound address, and even that one can be turned off:** no telemetry,
  no traffic logs. The probe goes to the user's own server. The single third
  party is `ip-api.com`, asked for the exit point, and it is asked **through the
  tunnel**: the service sees your server's address, not yours. Turned off by the
  "ask for country" setting or `PG_GEO=0`. The window reaches `api.github.com`
  for updates only when the button is pressed — never on its own, never in the
  background.
- **TS strict** in the frontend.

## Documentation

| | |
| --- | --- |
| [How it works](docs/how-it-works.md) | the tunnel, the sing-box config, the firewall, DNS, the principles in full |
| [Installing on Windows](docs/install.md) | the installer, updates, what the service remembers, a foreign VPN nearby |
| [Profiles, subscriptions and testing](docs/profiles.md) | importing links and subscriptions, Clash YAML, measuring nodes |
| [Browser profiles](docs/browser-profiles.md) | separate browser sessions and what a site sees of them |
| [The window](docs/interface.md) | connections, language, tray and the panel, settings |
| [Development](docs/development.md) | crate layout, commands, variables, when something does not work |
| [What is still missing](docs/limitations.md) | known holes, ordered by the cost of the mistake |
| [Brand](docs/brand.md) | the mark, the fills, clear space, the don'ts |
| [WFP: measured, not adopted](docs/wfp.md) | why there is no filter of our own |

The documentation is written in Russian: Russian is the source language of this
project and the key its translations are looked up by. Only the README is
translated.

Building and releasing the installer — [src-tauri/BUILD-WINDOWS.md](src-tauri/BUILD-WINDOWS.md).
