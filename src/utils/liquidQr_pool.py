"""
LIQUID QR WORKER POOL — parallel render server (GIL-safe process pool).

The single-threaded renderer (~570ms/QR) queues requests serially under load.
This launcher spawns N independent worker processes, each running liquidQr.py
--server on its own port (9770..9770+N-1), and a dispatcher on port 9765 that
round-robins incoming requests across healthy workers.

Launch:  python3 liquidQr_pool.py [num_workers]
  Workers:   127.0.0.1:9770 .. 9770+N-1
  Dispatcher: 127.0.0.1:9765  (same protocol as single server mode)

No change to the QR algorithm, style, or output pixels. Only parallelism.
"""
import socket
import sys
import os
import time
import json
import subprocess
import threading

BASE_PORT = 9770
N_WORKERS = int(sys.argv[1]) if len(sys.argv) > 1 else 4


def spawn_worker(idx):
    script = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'liquidQr.py')
    proc = subprocess.Popen(
        ['python3', script, '--server', str(BASE_PORT + idx)],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    return proc


def wait_for_worker(port, timeout=30):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            s.settimeout(1)
            s.connect(('127.0.0.1', port))
            s.close()
            return True
        except Exception:
            time.sleep(0.5)
    return False


def worker_request(port, payload_json, timeout=60):
    """Send one JSON render request to a worker; return raw response string."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(timeout)
    sock.connect(('127.0.0.1', port))
    sock.sendall((payload_json + '\n').encode('ascii'))
    buf = b''
    while b'\nDONE\n' not in buf:
        chunk = sock.recv(65536)
        if not chunk:
            raise RuntimeError('worker closed connection')
        buf += chunk
    return buf.decode('ascii')


def main():
    workers = []
    for i in range(N_WORKERS):
        proc = spawn_worker(i)
        port = BASE_PORT + i
        ok = wait_for_worker(port)
        workers.append({'idx': i, 'port': port, 'proc': proc, 'ok': ok,
                        'busy': False, 'errors': 0})
        print(f'worker {i} port {port}: {"UP" if ok else "FAILED"}', flush=True)
        if not ok:
            proc.terminate()

    healthy = [w for w in workers if w['ok']]
    if not healthy:
        print('FATAL: no workers came up', flush=True)
        sys.exit(1)

    lock = threading.Lock()
    next_idx = [0]

    def dispatch(conn):
        try:
            buf = b''
            while b'\n' not in buf:
                chunk = conn.recv(4096)
                if not chunk:
                    return
                buf += chunk
            payload_json = buf.decode('utf-8').strip()
            # round-robin over healthy workers
            with lock:
                attempts = len(healthy)
                for _ in range(attempts):
                    idx = next_idx[0] % len(healthy)
                    next_idx[0] += 1
                    w = healthy[idx]
                    if w['busy']:
                        continue
                    w['busy'] = True
                    break
                else:
                    # all busy — pick least-busy anyway (workers are threaded)
                    w = healthy[next_idx[0] % len(healthy)]
                    w['busy'] = True
            try:
                resp = worker_request(w['port'], payload_json)
                if resp.startswith('ERROR'):
                    w['errors'] += 1
                    if w['errors'] >= 3:
                        w['ok'] = False
                        healthy[:] = [x for x in healthy if x['ok']]
                conn.sendall(resp.encode('ascii'))
            except Exception:
                w['errors'] += 1
                if w['errors'] >= 3:
                    w['ok'] = False
                    healthy[:] = [x for x in healthy if x['ok']]
                conn.sendall(b'ERROR: worker failed\n')
            finally:
                w['busy'] = False
        except Exception:
            pass
        finally:
            try:
                conn.close()
            except Exception:
                pass

    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(('127.0.0.1', 9765))
    srv.listen(512)
    print(f'liquidQr pool dispatcher on 127.0.0.1:9765 with {len(healthy)} workers', flush=True)

    def _respawn_loop():
        """Watch workers and respawn any that died (OOM, crash)."""
        while True:
            time.sleep(10)
            for w in workers:
                if w['ok'] and w['proc'].poll() is not None:
                    print(f'respawning worker {w["idx"]} (exited {w["proc"].returncode})', flush=True)
                    proc = spawn_worker(w['idx'])
                    w['proc'] = proc
                    w['errors'] = 0
                    if wait_for_worker(w['port'], timeout=30):
                        w['ok'] = True
                        if w not in healthy:
                            healthy.append(w)
                        print(f'worker {w["idx"]} port {w["port"]}: UP (respawned)', flush=True)
                    else:
                        w['ok'] = False
                        healthy[:] = [x for x in healthy if x['ok']]

    threading.Thread(target=_respawn_loop, daemon=True).start()
    while True:
        conn, _ = srv.accept()
        threading.Thread(target=dispatch, args=(conn,), daemon=True).start()


if __name__ == '__main__':
    main()
