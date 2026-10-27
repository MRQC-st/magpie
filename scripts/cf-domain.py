"""Scoped Cloudflare operations; credentials travel over SSH stdin, never argv."""
import base64
import json
import pathlib
import shlex
import subprocess
import sys

REMOTE = r'''
import json, sys, subprocess
p = json.load(sys.stdin)
config = 'url = ' + json.dumps('https://api.cloudflare.com/client/v4/' + p['endpoint']) + '\n'
config += 'header = ' + json.dumps('Authorization: Bearer ' + p['token']) + '\n'
config += 'header = "Content-Type: application/json"\n'
config += 'request = ' + json.dumps(p['method']) + '\n'
if p['body'] is not None:
    config += 'data = ' + json.dumps(json.dumps(p['body'])) + '\n'
r = subprocess.run(['curl', '-4', '-sS', '--connect-timeout', '8', '--max-time', '25', '--config', '-'],
                   input=config, text=True, capture_output=True, timeout=30)
if r.returncode:
    print(json.dumps({'success': False, 'errors': [{'message': r.stderr[:300]}]}))
    sys.exit(1)
d = json.loads(r.stdout)
print(json.dumps(d))
sys.exit(0 if d.get('success') else 1)
'''
SECRETS = pathlib.Path('D:/projects/secrets/.env')
HOST = '43.131.227.120'
ZONE = '1b8762a91fa7b922850021f3f1518343'
OLD_ZONE = 'ce7904d2462a210f315bad75f790fe32'
OLD_RECORD = '908e716f5f392078b01fbecbd2144bc1'
OLD_ACCOUNT = 'ca0abe3dc6f7b8e5850ae016f3ec146d'
OLD_TUNNEL = 'd12e5d04-d3e9-457c-bb84-248f0fe91877'
NAME = 'magpie.sunfolower.cn'


def api(endpoint, token_name='CF_TOKEN', method='GET', body=None):
    token = None
    for line in SECRETS.read_text(encoding='utf-8-sig').splitlines():
        k, sep, v = line.partition('=')
        if sep and k.strip() == token_name:
            token = v.strip().strip('\"\'')
    if not token:
        raise RuntimeError('Required credential is absent')
    code = 'import base64;exec(base64.b64decode(' + repr(base64.b64encode(REMOTE.encode()).decode()) + '))'
    command = ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15',
               '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2', HOST,
               'python3 -I -c ' + shlex.quote(code)]
    result = subprocess.run(command, input=json.dumps({'endpoint': endpoint, 'token': token,
                            'method': method, 'body': body}), text=True, capture_output=True, timeout=75)
    if not result.stdout.strip():
        raise RuntimeError('SSH/API returned no JSON: ' + result.stderr[:300])
    d = json.loads(result.stdout)
    if result.returncode or not d.get('success'):
        raise RuntimeError(json.dumps(d.get('errors', [])))
    return d['result']


def show(label, data):
    print(label + ': ' + json.dumps(data, ensure_ascii=False))


def main():
    action = sys.argv[1]
    if action == 'inspect':
        z = api('zones/' + ZONE)
        assert z['name'] == 'sunfolower.cn', 'Unexpected zone'
        show('ZONE', {k: z[k] for k in ['id', 'name', 'status', 'account']})
        show('DNS_MAGPIE', api(f'zones/{ZONE}/dns_records?name={NAME}'))
        try:
            show('SSL', api(f'zones/{ZONE}/settings/ssl'))
        except RuntimeError as e:
            show('SSL_UNAVAILABLE', str(e))
        for rule in api(f'zones/{ZONE}/pagerules'):
            show('PAGE_RULE', {'url': rule['targets'], 'actions': rule['actions'], 'status': rule['status']})
        for rec in api(f'zones/{ZONE}/dns_records?per_page=100&type=A,CNAME,AAAA'):
            show('DNS', {'name': rec['name'], 'type': rec['type'], 'content': rec['content'], 'proxied': rec.get('proxied')})
    elif action == 'dns-create':
        z = api('zones/' + ZONE)
        assert z['name'] == 'sunfolower.cn'
        records = api(f'zones/{ZONE}/dns_records?name={NAME}')
        if records:
            assert len(records) == 1 and all(records[0].get(k) == v for k, v in
                {'type': 'A', 'content': HOST, 'proxied': True}.items()), 'DNS exists with different values; refusing overwrite'
            show('DNS_ALREADY_MATCHES', records)
        else:
            show('DNS_CREATED', api(f'zones/{ZONE}/dns_records', method='POST',
                body={'type': 'A', 'name': NAME, 'content': HOST, 'proxied': True, 'ttl': 1,
                      'comment': 'Magpie web UI and API via Tencent nginx'}))
    elif action == 'old-inspect':
        r = api(f'zones/{OLD_ZONE}/dns_records/{OLD_RECORD}', 'CF2_TOKEN')
        assert r['name'] == 'magpie.autofile.cc.cd' and r['content'] == OLD_TUNNEL + '.cfargotunnel.com'
        show('OLD_DNS', r)
        t = api(f'accounts/{OLD_ACCOUNT}/cfd_tunnel/{OLD_TUNNEL}', 'CF2_TOKEN')
        show('OLD_TUNNEL', {k: t.get(k) for k in ['id','name','status','deleted_at']})
        show('OLD_CONFIG', api(f'accounts/{OLD_ACCOUNT}/cfd_tunnel/{OLD_TUNNEL}/configurations', 'CF2_TOKEN'))
    elif action == 'old-remove':
        r = api(f'zones/{OLD_ZONE}/dns_records/{OLD_RECORD}', 'CF2_TOKEN')
        assert r['name'] == 'magpie.autofile.cc.cd' and r['content'] == OLD_TUNNEL + '.cfargotunnel.com'
        t = api(f'accounts/{OLD_ACCOUNT}/cfd_tunnel/{OLD_TUNNEL}', 'CF2_TOKEN')
        assert t['name'] == 'magpie-tunnel' and not t.get('connections'), 'Tunnel still connected; stop its dedicated service first'
        show('OLD_DNS_REMOVED', api(f'zones/{OLD_ZONE}/dns_records/{OLD_RECORD}', 'CF2_TOKEN', method='DELETE'))
        show('OLD_TUNNEL_REMOVED', api(f'accounts/{OLD_ACCOUNT}/cfd_tunnel/{OLD_TUNNEL}', 'CF2_TOKEN', method='DELETE'))
    elif action == 'old-verify':
        show('OLD_DNS_REMAINING', api(f'zones/{OLD_ZONE}/dns_records?name=magpie.autofile.cc.cd', 'CF2_TOKEN'))
        t = api(f'accounts/{OLD_ACCOUNT}/cfd_tunnel/{OLD_TUNNEL}', 'CF2_TOKEN')
        show('OLD_TUNNEL_DELETED_AT', t.get('deleted_at'))
    else:
        raise SystemExit('Unknown action')

if __name__ == '__main__':
    main()
