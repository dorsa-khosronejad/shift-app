#!/bin/bash

# Start development servers for Shift & Care app

echo "================================"
echo "Starting Shift & Care Dev Servers"
echo "================================"

# Kill any existing processes on ports 4000 and 5500
echo "Cleaning up old processes..."
lsof -i :4000 | grep LISTEN | awk '{print $2}' | xargs kill -9 2>/dev/null
lsof -i :5500 | grep LISTEN | awk '{print $2}' | xargs kill -9 2>/dev/null
sleep 1

# Start backend server
echo ""
echo "🚀 Starting Backend Server..."
cd "$(dirname "$0")/backend"
node server.js &
BACKEND_PID=$!
echo "   Backend PID: $BACKEND_PID"
echo "   Running on http://localhost:4000"
sleep 2

# Start frontend server
echo ""
echo "🚀 Starting Frontend Server..."
cd "$(dirname "$0")/frontend"
python3 -m http.server 5500 &
FRONTEND_PID=$!
echo "   Frontend PID: $FRONTEND_PID"
echo "   Running on http://192.168.0.62:5500"

echo ""
echo "================================"
echo "✅ Both servers running!"
echo "================================"
echo ""
echo "Login with:"
echo "  Email: admin@demo.local"
echo "  Password: Admin123!"
echo ""
echo "Press Ctrl+C to stop all servers"
echo ""

# Keep script running
wait
