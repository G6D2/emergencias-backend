class OfficerController {
  constructor(officerRepository) {
    this.officerRepository = officerRepository;
  }

  async listOfficers(query = {}) {
    const status = typeof query.status === 'string' && query.status.trim()
      ? query.status.trim()
      : undefined;
    const officers = await this.officerRepository.findAll({ status });
    return { data: officers };
  }
}

module.exports = { OfficerController };
