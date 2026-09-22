package backend

// RegisterBusinessHandlers installs native implementations only. Missing
// operations remain explicit failures and never count as parity coverage.
func(s *Server)RegisterBusinessHandlers(){
	s.registerAuth()
}
