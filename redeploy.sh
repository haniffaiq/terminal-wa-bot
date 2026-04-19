#!/bin/bash
echo "Stopping containers..."
docker compose down

echo "Removing images..."
docker compose down --rmi all

echo "Rebuilding and starting..."
docker compose up --build -d

echo "Done. Containers:"
docker compose ps
