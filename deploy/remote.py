"""Deployment transport. Connection settings come from environment variables or the SSH agent."""
import argparse, os, sys, time
import paramiko

def connect():
    host = os.environ.get('DRIVE_SSH_HOST')
    if not host:
        raise RuntimeError('Set DRIVE_SSH_HOST')
    client=paramiko.SSHClient();client.load_system_host_keys();client.set_missing_host_key_policy(paramiko.RejectPolicy())
    client.connect(host, username=os.environ.get('DRIVE_SSH_USER','root'),
                   password=os.environ.get('DRIVE_SSH_PASSWORD'), timeout=20)
    return client

def run(client,cmd):
    _,out,err=client.exec_command(cmd)
    channel=out.channel
    while not channel.exit_status_ready() or channel.recv_ready() or channel.recv_stderr_ready():
        if channel.recv_ready():print(channel.recv(65536).decode('utf-8',errors='replace'),end='',flush=True)
        if channel.recv_stderr_ready():print(channel.recv_stderr(65536).decode('utf-8',errors='replace'),end='',file=sys.stderr,flush=True)
        time.sleep(.03)
    return channel.recv_exit_status()

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('action',choices=['exec','put','get']);p.add_argument('args',nargs='+');a=p.parse_args()
    c=connect()
    try:
        if a.action=='exec':sys.exit(run(c,a.args[0]))
        else:
            s=c.open_sftp()
            if a.action=='put':s.put(a.args[0],a.args[1])
            else:s.get(a.args[0],a.args[1])
            s.close()
    finally:c.close()
