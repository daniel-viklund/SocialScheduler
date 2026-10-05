#!/usr/bin/env python3
"""Allow only the scheduler's Docker port from the home LAN; run with sudo."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time

CONFIG = Path('/etc/nftables.d/bikefable.nft')
RULE = ('    iifname "eno1" ip saddr 192.168.0.0/24 '
        'ct status dnat ct original ip daddr 192.168.0.63 '
        'meta l4proto tcp ct original proto-dst 3000 tcp dport 8080 '
        'counter accept comment "Social Scheduler home LAN"\n')
ANCHOR = '    iifname { "eno1", "tailscale0" } drop\n'


def updated_rules(original):
    if RULE in original:
        return original
    if original.count(ANCHOR) != 1 or original.count('  chain forward {') != 1:
        raise RuntimeError('Firewall layout changed; inspect it before proceeding.')
    if original.index(ANCHOR) < original.index('  chain forward {'):
        raise RuntimeError('Expected drop rule in the forward chain.')
    return original.replace(ANCHOR, RULE + ANCHOR)


def main():
    if os.geteuid() != 0:
        raise SystemExit('Run with sudo python3 ' + str(Path(__file__).resolve()))
    original = CONFIG.read_text()
    updated = updated_rules(original)
    if updated == original:
        print('Scheduler LAN rule already exists.')
        return
    fd, filename = tempfile.mkstemp(prefix='.scheduler-', dir=CONFIG.parent)
    candidate = Path(filename)
    try:
        with os.fdopen(fd, 'w') as stream:
            stream.write(updated)
        subprocess.run(['/usr/sbin/nft', '--check', '--file', str(candidate)], check=True)
        backup = CONFIG.with_name(CONFIG.name + '.backup-' + str(time.time_ns()))
        shutil.copy2(CONFIG, backup)
        os.replace(candidate, CONFIG)
        try:
            subprocess.run(['systemctl', 'reload', 'bikefable-firewall.service'], check=True)
        except subprocess.CalledProcessError:
            shutil.copy2(backup, CONFIG)
            subprocess.run(['systemctl', 'reload', 'bikefable-firewall.service'], check=True)
            raise
        print('Enabled http://192.168.0.63:3000 for 192.168.0.0/24.')
        print('Previous configuration: ' + str(backup))
    finally:
        candidate.unlink(missing_ok=True)


if __name__ == '__main__':
    main()
