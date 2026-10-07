#!/usr/bin/env python3
"""Propose a forward-only version from an explicitly supplied publication ledger.
No device I/O, signing material, network request or ledger mutation.
"""
import argparse
import json

MAX_CODE = 2_100_000_000
STRIDE = 1_000_000


def propose(highest: int, kind: str) -> int:
    if not 0 <= highest < MAX_CODE or kind not in ('podjs', 'recovery'):
        raise ValueError('invalid highest-published or kind')
    epoch = highest // STRIDE
    if kind == 'podjs':
        code = max(highest + 1, epoch * STRIDE + 1000)
        if code >= epoch * STRIDE + 900000:
            epoch += 1
            code = epoch * STRIDE + 1000
    else:
        code = max(highest + 1, epoch * STRIDE + 900000)
    if code > MAX_CODE:
        raise ValueError('Android version-code range exhausted; release-owner decision required')
    return code


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--highest-published', type=int, required=True)
    p.add_argument('--kind', choices=('podjs', 'recovery'), required=True)
    args = p.parse_args()
    try:
        code = propose(args.highest_published, args.kind)
    except ValueError as error:
        p.error(str(error))
    print(json.dumps({'highestPublished': args.highest_published, 'kind': args.kind,
                      'proposedVersionCode': code, 'published': False}))


if __name__ == '__main__':
    main()
