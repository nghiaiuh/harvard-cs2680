def divide(a, b):
    return a / b  # Bug: missing check for division by zero

def average(numbers):
    return sum(numbers) / len(numbers)  # Bug: crashes if numbers list is empty
