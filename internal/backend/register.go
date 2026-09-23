package backend

// RegisterBusinessHandlers installs native implementations. Missing operations
// remain explicit errors and are never proxied to the TypeScript reference.
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
	s.registerFoodPlans()
	s.registerNutritionRecords()
	s.registerKnowledge()
	s.registerBooks()
}
