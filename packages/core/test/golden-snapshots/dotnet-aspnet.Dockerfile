# syntax=docker/dockerfile:1
# --- Stage 1: Build ---------------------------------------
FROM --platform=$BUILDPLATFORM mcr.microsoft.com/dotnet/sdk:8.0 AS builder

WORKDIR /src

COPY src/MyApi.csproj ./src/
RUN dotnet restore "src/MyApi.csproj"

COPY src/ ./src/
RUN dotnet publish "src/MyApi.csproj" -c Release -o /app/publish --no-restore --runtime linux-x64 --self-contained false

# --- Stage 2: Runtime -------------------------------------
FROM mcr.microsoft.com/dotnet/aspnet:8.0

WORKDIR /app

ENV DOTNET_RUNNING_IN_CONTAINER=true \
    ASPNETCORE_URLS=http://+:8080

RUN addgroup --system appgroup && adduser --system --ingroup appgroup appuser
USER appuser

COPY --from=builder /app/publish .

EXPOSE 8080
ENTRYPOINT ["dotnet", "MyApi.dll"]
