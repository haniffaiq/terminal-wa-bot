#!/bin/bash
echo "Stopping containers and removing volumes..."
docker compose down -v --rmi all

echo "Rebuilding and starting..."
docker compose up --build -d

echo "Done. Containers:"
docker compose ps
