"""Temporary loopback-only SSH tunnel for staging checks."""
import select, socketserver, sys
from remote import connect
client=connect();remote_port=int(sys.argv[2])
class Handler(socketserver.BaseRequestHandler):
    def handle(self):
        channel=client.get_transport().open_channel('direct-tcpip',('127.0.0.1',remote_port),self.request.getpeername())
        try:
            while True:
                ready,_,_=select.select([self.request,channel],[],[],30)
                for source in ready:
                    data=source.recv(65536)
                    if not data:return
                    (channel if source is self.request else self.request).sendall(data)
        finally:channel.close()
class Server(socketserver.ThreadingTCPServer):allow_reuse_address=True;daemon_threads=True
with Server(('127.0.0.1',int(sys.argv[1])),Handler) as server:
    print('Staging tunnel ready',flush=True);server.serve_forever()
