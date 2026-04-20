#!/bin/bash
echo "Stopping containers and removing ALL volumes (DB will be reset)..."
docker compose down -v --rmi all

echo "Rebuilding and starting..."
docker compose up --build -d

echo "Done. Containers:"
docker compose ps
