package backend

// Missing operations fail explicitly; registered implementations never proxy
// business execution to the frozen TypeScript reference.
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
	s.registerSupplementCatalog()
	s.registerMedicalReports()
	s.registerVaccines()
	s.registerGrowth()
	s.registerSyncFeeds()
	s.registerAIHistory()
	s.registerRecordSnapshots()
	s.registerAIRunReads()
	s.registerAIRunCommands()
	s.registerFamilySnapshots()
	s.registerSyncCommands()
	s.registerAttachments()
	s.registerLegacyAttachments()
}
