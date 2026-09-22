package backend

// RegisterBusinessHandlers installs native implementations only. Missing
// operations remain explicit failures and never count as parity coverage.
func (s *Server) RegisterBusinessHandlers() {
	s.registerAuth()
	s.registerFamilies()
	s.registerBabies()
	s.registerCare()
	s.registerNotifications()
	s.registerVoiceLogs()
	s.registerWebAISessions()
	s.registerFormulaProducts()
	s.registerFoodLibrary()
}
