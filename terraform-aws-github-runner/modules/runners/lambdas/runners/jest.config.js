module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  collectCoverage: true,
  collectCoverageFrom: ['src/**/*.{ts,js,jsx}'],
  reporters: ['<rootDir>/test/reporter.js'],
  coverageThreshold: {
    global: {
      branches: 80,
      functions: 90,
      lines: 93,
      statements: 94
    }
  }
};
