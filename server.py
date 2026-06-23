import http.server
import socketserver
import socket
import os

PORT = 8000

def get_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        # doesn't even have to be reachable
        s.connect(('10.255.255.255', 1))
        IP = s.getsockname()[0]
    except Exception:
        IP = '127.0.0.1'
    finally:
        s.close()
    return IP

ip_address = get_ip()

class Handler(http.server.SimpleHTTPRequestHandler):
    pass

with socketserver.TCPServer(("", PORT), Handler) as httpd:
    print("="*50)
    print(" サーバーが起動しました！")
    print("="*50)
    print(f"\n【PCで確認する場合】")
    print(f"  http://localhost:{PORT}")
    print(f"\n【スマホで確認する場合】 (同じWi-Fiに接続してください)")
    print(f"  http://{ip_address}:{PORT}")
    print("\n※ スマホのブラウザ（Chrome等）でカメラを許可するためには、")
    print("   以下の手順でセキュリティ制限を一時的に解除する必要があります：")
    print("   1. スマホのChromeで chrome://flags/#unsafely-treat-insecure-origin-as-secure を開く")
    print(f"   2. 入力欄に http://{ip_address}:{PORT} を入力する")
    print("   3. 右のボタンを「Enabled」にして、右下の「Relaunch」を押す")
    print("\n終了するにはこのウィンドウを閉じるか、Ctrl+Cを押してください。")
    print("="*50)
    
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nサーバーを停止しました。")
