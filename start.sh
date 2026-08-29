docker build -t duett . --no-cache
docker run -d \
  --name duett \
  -p 3003:3003 \
  -v duett_data:/app/data \
  -e BASE_PATH=/duett \
  --restart unless-stopped \
  duett