from http.server import BaseHTTPRequestHandler
import json, os

class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        api_key = os.getenv("AI_API_KEY")
        if not api_key:
            self.send_response(503)
            self.send_header('Content-type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({"error": "AI API not configured"}).encode('utf-8'))
            return

        self.send_response(200)
        self.send_header('Content-type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps({"status": "ready"}).encode('utf-8'))
