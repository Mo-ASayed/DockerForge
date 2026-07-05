package server

import "net/http"

func Run() {
	http.ListenAndServe(":8080", nil)
}
