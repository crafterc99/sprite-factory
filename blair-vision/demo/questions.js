// Demo question bank. `answer` is the index of the correct choice (used ONLY by the local mock Jev server).
// mode: radio | buttons | react | ol | aria | shuffle-react
window.QUESTIONS = [
  { id: 1, mode: 'radio', q: 'What planet is largest?', choices: ['Earth', 'Mars', 'Jupiter', 'Venus'], answer: 2 },
  { id: 2, mode: 'buttons', q: 'What is the capital of France?', choices: ['Berlin', 'Madrid', 'Paris', 'Rome'], answer: 2 },
  { id: 3, mode: 'react', q: 'Which liquid is commonly called H2O?', choices: ['Water', 'Hydrogen peroxide', 'Salt water', 'Ammonia'], answer: 0 },
  { id: 4, mode: 'ol', q: 'What is the chemical symbol for gold?', choices: ['Ag', 'Au', 'Gd', 'Go'], answer: 1 },
  { id: 5, mode: 'radio-prefix', q: 'What is 7 x 8?', choices: ['54', '56', '58', '64'], answer: 1 },
  { id: 6, mode: 'shuffle-react', q: 'Who wrote the play Romeo and Juliet?', choices: ['Charles Dickens', 'Jane Austen', 'William Shakespeare', 'Mark Twain'], answer: 2 },
  { id: 7, mode: 'aria', q: 'Which is the largest ocean on Earth?', choices: ['Atlantic', 'Indian', 'Arctic', 'Pacific'], answer: 3 },
  { id: 8, mode: 'buttons', q: 'At sea level, at what temperature in Celsius does water boil?', choices: ['50', '90', '100', '212'], answer: 2 },
  { id: 9, mode: 'shuffle-react', q: 'Which liquid is commonly called H2O?', choices: ['Water', 'Hydrogen peroxide', 'Salt water', 'Ammonia'], answer: 0, repeatOf: 3 },
  { id: 10, mode: 'radio', q: 'Which is the fastest land animal?', choices: ['Lion', 'Cheetah', 'Horse', 'Greyhound'], answer: 1 },
  { id: 11, mode: 'ol', q: 'How many continents are there?', choices: ['5', '6', '7', '9'], answer: 2 },
  { id: 12, mode: 'react', q: 'Roughly how fast does light travel in a vacuum?', choices: ['300,000 km/s', '3,000 km/s', '30,000 km/h', '300 km/s'], answer: 0 },
];
